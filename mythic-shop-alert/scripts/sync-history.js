'use strict';
require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const { ensureHistoryTables, syncHistoryCatalog } = require('../lib/history-sync');

const dbPath = path.resolve(__dirname, '..', process.env.DATABASE_PATH || './data/mythic-shop.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
ensureHistoryTables(db);

syncHistoryCatalog(db)
  .then(result => {
    if (result.skipped) {
      console.error(result.reason);
      process.exitCode = 1;
      return;
    }
    console.log('\n역사 카탈로그 동기화 완료');
    console.log(`API 기록 날짜: ${result.availableHistoryDays}개`);
    console.log(`이번에 새로 가져온 날짜: ${result.newlyImportedDays}개`);
    console.log(`이번 처리 상품 항목: ${result.itemEntriesProcessed}개`);
    console.log(`누적 카탈로그 상품: ${result.catalogItems}개`);
    console.log(`기록 범위: ${result.historyFrom || '?'} ~ ${result.historyThrough || '?'}`);
  })
  .catch(error => {
    console.error('역사 카탈로그 동기화 실패:', error.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
