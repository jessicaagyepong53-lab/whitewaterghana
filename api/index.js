const { connectDB } = require('../server/db');

let dbReady = null;

function ensureDB() {
  if (!dbReady) dbReady = connectDB();
  return dbReady;
}

const app = require('../server');

module.exports = async (req, res) => {
  try {
    await ensureDB();
    return app(req, res);
  } catch (error) {
    const message = error && error.message ? error.message : 'Database connection failed';
    return res.status(500).json({
      message: `Server initialization error: ${message}`,
    });
  }
};
