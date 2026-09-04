// lib/vector.js — cw-mem 向量召回层。
//
// 关键约束: 写入前对 embedding L2 归一化; sqlite-vec 返回 L2^2, 在归一化向量上:
//   sim = 1 / (1 + distance)  与 cosine 相似度保持单调同向, 适合做 minScore 阈值。
//
// 写流程: INSERT INTO memories_meta(..., created_at)  →  last_insert_rowid()
//   → INSERT INTO memories_vec(rowid, embedding) VALUES (<inline>, ...)
//   (sqlite-vec 怪癖: rowid 必须是字面量整数, 不能绑定参数, 也不能用 last_insert_rowid() 绑定。)

const nowIso = () => new Date().toISOString();

function vecToBuffer(vec) {
  return Buffer.from(new Float32Array(vec).buffer);
}

function normalize(vec) {
  let s = 0;
  for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
  s = Math.sqrt(s);
  if (s === 0) return vec.slice();
  return vec.map(x => x / s);
}

function vecToHex(vec) {
  // 与 vecToBuffer 等价的 hex 形式, 用于拼到 SQL 字符串里(inline 整数 rowid 配合使用)
  return vecToBuffer(vec).toString('hex');
}

function storeEmbedding({ db, entity_type, ref_id, project, type, concepts, files_modified, title, subtitle, text, embedding }) {
  if (!Array.isArray(embedding)) throw new Error('storeEmbedding: embedding must be array');
  const normed = normalize(embedding);
  // 替换语义: 同一 (entity_type, ref_id) 的旧向量先清掉, 避免重算(换模型/重试)时产生重复 meta/vec
  const stale = db.prepare('SELECT rowid FROM memories_meta WHERE entity_type = ? AND ref_id = ?').all(entity_type, ref_id);
  if (stale.length) {
    const ids = stale.map(r => r.rowid).join(',');
    db.exec(`DELETE FROM memories_vec WHERE rowid IN (${ids})`);
    db.prepare('DELETE FROM memories_meta WHERE entity_type = ? AND ref_id = ?').run(entity_type, ref_id);
  }
  const meta = db.prepare(`
    INSERT INTO memories_meta
      (entity_type, ref_id, project, type, concepts, files_modified, title, subtitle, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entity_type,
    ref_id,
    project || '',
    type || '',
    concepts || '[]',
    files_modified || '[]',
    title || '',
    subtitle || '',
    nowIso()
  );
  const rowid = Number(meta.lastInsertRowid);
  // sqlite-vec 怪癖: rowid 必须是字面量整数; 也不能用 last_insert_rowid() 子查询
  // 直接用 lastInsertRowid 已经知道值, 拼到 SQL 字符串里是安全的
  db.exec(`INSERT INTO memories_vec(rowid, embedding) VALUES (${rowid}, x'${vecToHex(normed)}')`);
  return rowid;
}

function knnRecall({ db, queryVec, topK, project }) {
  if (!Buffer.isBuffer(queryVec)) queryVec = vecToBuffer(queryVec);
  // sqlite-vec 怪癖: 跟其他表 JOIN 时, KNN 限流必须用 "k = ?" 形式, LIMIT ? 会被拒绝。
  const rows = db.prepare(`
    SELECT v.rowid, v.distance, m.entity_type, m.ref_id, m.project, m.type, m.concepts, m.files_modified, m.title, m.subtitle, m.created_at
    FROM memories_vec v
    JOIN memories_meta m ON v.rowid = m.rowid
    WHERE v.embedding MATCH ? AND k = ?
    ORDER BY v.distance ASC
  `).all(queryVec, topK);
  return rows
    .filter(r => !project || r.project === project)
    .filter(r => r.type !== 'skip');
}

function hybridFileRecall({ db, file, queryVec, topK, project }) {
  if (!Buffer.isBuffer(queryVec)) queryVec = vecToBuffer(queryVec);
  // files_modified 是 JSON 字符串数组, 用 '"<filename>"' 包裹的 LIKE 防止 server 命中 server.jsx
  const needle = `%"${file}"%`;
  const candidates = db.prepare(`
    SELECT rowid, ref_id, entity_type, project, type, title, subtitle, files_modified
    FROM memories_meta
    WHERE files_modified LIKE ?
  `).all(needle);
  const filtered = candidates
    .filter(r => !project || r.project === project)
    .filter(r => r.type !== 'skip')
    .map(r => r.rowid);
  if (filtered.length === 0) return [];
  // 拼 rowid IN (...) 字面量, sqlite-vec 在 KNN 时也用相同的 rowid 限定。
  // 同样: JOIN 场景下必须用 k = ? 而非 LIMIT ?
  const ids = filtered.join(',');
  const rows = db.prepare(`
    SELECT v.rowid, v.distance, m.entity_type, m.ref_id, m.project, m.type, m.concepts, m.files_modified, m.title, m.subtitle, m.created_at
    FROM memories_vec v
    JOIN memories_meta m ON v.rowid = m.rowid
    WHERE v.rowid IN (${ids}) AND v.embedding MATCH ? AND k = ?
    ORDER BY v.distance ASC
  `).all(queryVec, topK);
  return rows;
}

module.exports = { vecToBuffer, normalize, storeEmbedding, knnRecall, hybridFileRecall };
