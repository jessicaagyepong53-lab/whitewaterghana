const { connectDB } = require('../server/db');

let dbReady = null;

function ensureDB() {
  if (!dbReady) dbReady = connectDB();
  return dbReady;
}

const app = require('../server');

module.exports = async (req, res) => {
  await ensureDB();
  return app(req, res);
};
