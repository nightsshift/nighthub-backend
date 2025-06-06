const { getFirestore } = require('firebase-admin/firestore');

module.exports = {
  db: getFirestore(),
};