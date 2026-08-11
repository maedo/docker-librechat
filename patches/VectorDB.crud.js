const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { logAxiosError } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { FileSources } = require('librechat-data-provider');
const { generateShortLivedToken } = require('~/server/services/AuthService');

/**
 * SG patch: también guarda el archivo en uploads/<userId>/ para que el MCP
 * (volumen compartido) pueda procesar planillas Excel sin depender del bind Laudus.
 */
async function dualWriteLocalForMcp({ req, file, file_id }) {
  const uploads = req.app?.locals?.paths?.uploads;
  if (!uploads || !req.user?.id) {
    return null;
  }
  const userPath = path.join(uploads, req.user.id);
  await fs.promises.mkdir(userPath, { recursive: true });
  const original = file.originalname || path.basename(file.path);
  const fileName = `${file_id}__${path.basename(original)}`;
  const dest = path.join(userPath, fileName);
  await fs.promises.copyFile(file.path, dest);
  const filepath = path.posix.join('/', 'uploads', req.user.id, fileName);
  logger.info(`[SG] Dual-write MCP: ${dest}`);
  return { filepath, bytes: file.size, filename: original, localPath: dest };
}

function isSpreadsheetUpload(file) {
  const mime = (file.mimetype || '').toLowerCase();
  const name = (file.originalname || file.path || '').toLowerCase();
  return (
    mime.includes('spreadsheet') ||
    mime.includes('excel') ||
    mime === 'application/vnd.ms-excel' ||
    name.endsWith('.xlsx') ||
    name.endsWith('.xls') ||
    name.endsWith('.csv')
  );
}

/**
 * Deletes a file from the vector database.
 */
const deleteVectors = async (req, file) => {
  if (!file.embedded || !process.env.RAG_API_URL) {
    return;
  }
  try {
    const jwtToken = generateShortLivedToken(req.user.id);

    return await axios.delete(`${process.env.RAG_API_URL}/documents`, {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      data: [file.file_id],
    });
  } catch (error) {
    logAxiosError({
      error,
      message: 'Error deleting vectors',
    });
    if (
      error.response &&
      error.response.status !== 404 &&
      (error.response.status < 200 || error.response.status >= 300)
    ) {
      logger.warn('Error deleting vectors, file will not be deleted');
      throw new Error(error.message || 'An error occurred during file deletion.');
    }
  }
};

/**
 * Uploads a file to the configured Vector database (and dual-writes locally for MCP).
 */
async function uploadVectors({ req, file, file_id, entity_id }) {
  let localInfo = null;
  try {
    localInfo = await dualWriteLocalForMcp({ req, file, file_id });
  } catch (e) {
    logger.warn('[SG] Dual-write MCP failed (continuing with RAG):', e);
  }

  if (!process.env.RAG_API_URL) {
    if (localInfo) {
      return {
        bytes: localInfo.bytes,
        filename: localInfo.filename,
        filepath: localInfo.filepath,
        embedded: false,
      };
    }
    throw new Error('RAG_API_URL not defined');
  }

  try {
    const jwtToken = generateShortLivedToken(req.user.id);
    const formData = new FormData();
    formData.append('file_id', file_id);
    formData.append('file', fs.createReadStream(file.path));
    if (entity_id != null && entity_id) {
      formData.append('entity_id', entity_id);
    }

    const formHeaders = formData.getHeaders();

    const response = await axios.post(`${process.env.RAG_API_URL}/embed`, formData, {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        accept: 'application/json',
        ...formHeaders,
      },
    });

    const responseData = response.data;
    logger.debug('Response from embedding file', responseData);

    if (responseData.known_type === false) {
      if (localInfo && isSpreadsheetUpload(file)) {
        logger.warn(
          `[SG] RAG no indexa ${file.mimetype}; se conserva copia local para MCP: ${localInfo.localPath}`,
        );
        return {
          bytes: localInfo.bytes,
          filename: localInfo.filename,
          filepath: localInfo.filepath,
          embedded: false,
        };
      }
      throw new Error(`File embedding failed. The filetype ${file.mimetype} is not supported`);
    }

    if (!responseData.status) {
      if (localInfo && isSpreadsheetUpload(file)) {
        logger.warn('[SG] RAG embed status=false; se conserva copia local para MCP');
        return {
          bytes: localInfo.bytes,
          filename: localInfo.filename,
          filepath: localInfo.filepath,
          embedded: false,
        };
      }
      throw new Error('File embedding failed.');
    }

    return {
      bytes: file.size,
      filename: file.originalname,
      // Prefer local path when dual-write succeeded so MCP/shared volume can resolve it
      filepath: localInfo?.filepath || FileSources.vectordb,
      embedded: Boolean(responseData.known_type),
    };
  } catch (error) {
    if (localInfo && isSpreadsheetUpload(file)) {
      logger.warn('[SG] RAG embed error; se conserva copia local para MCP:', error.message || error);
      return {
        bytes: localInfo.bytes,
        filename: localInfo.filename,
        filepath: localInfo.filepath,
        embedded: false,
      };
    }
    logAxiosError({
      error,
      message: 'Error uploading vectors',
    });
    throw new Error(error.message || 'An error occurred during file upload.');
  }
}

module.exports = {
  deleteVectors,
  uploadVectors,
};
