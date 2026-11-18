'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const {
  ensureMasterPoolTable,
  migrateLegacyCatalogToMasterPool,
  importMasterPoolSeed,
  getMasterPoolStats
} = require('../lib/master-pool');

const root = path.resolve(__dirname, '..');
const dbPath = path.resolve(root, process.env.DATABASE_PATH || './data/mythic-shop.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
try {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureMasterPoolTable(db);
  const migrated = migrateLegacyCatalogToMasterPool(db);
  const seeded = importMasterPoolSeed(db);
  const stats = getMasterPoolStats(db);
  console.log('Master Pool 동기화 완료');
  console.log(`기존 카탈로그에서 이전: ${migrated}개`);
  console.log(`seed 파일 처리: ${seeded.imported}개 (신규 ${seeded.inserted}개 / 기존 항목 병합 ${seeded.alreadyPresent}개 / 오류 ${seeded.invalid}개)`);
  console.log(`전체 상품: ${stats.total}개 (확인 ${stats.confirmed}개 / 후보 ${stats.candidate}개)`);
} catch (error) {
  console.error('Master Pool 동기화 실패:', error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
