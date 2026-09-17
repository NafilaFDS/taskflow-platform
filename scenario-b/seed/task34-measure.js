// Task 34 - evidence for the tags.note_id index fix. Run once before and once
// after seed/fix-idx-tags-note-id.js, with no load test running:
//
//   docker compose exec -T mongodb sh -c \
//     'cat > /tmp/measure.js && mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin taskflow /tmp/measure.js' \
//     < seed/task34-measure.js
//
// explain("executionStats") is MongoDB's EXPLAIN ANALYZE: it really executes
// the query and reports the chosen plan with actual rows, keys and documents
// examined, and time taken.

const BENCH_ID_START = 900000000; // far above seeded/API tag ids, removed afterwards

// Long arrays (the 30,000 note ids of an $in, or their index bounds) are cut to
// their first 5 entries plus a count.
function compact(value) {
  return JSON.parse(JSON.stringify(value, (key, v) =>
    Array.isArray(v) && v.length > 5 ? [...v.slice(0, 5), `... ${v.length - 5} more`] : v
  ));
}

// Keep the fields that show the plan and the work done; drop engine internals
// (works, needTime, saveState, ...) that make the output hard to read.
function stages(stage) {
  if (!stage) return undefined;
  const keep = {
    stage: stage.stage,
    nReturned: stage.nReturned,
    executionTimeMillisEstimate: stage.executionTimeMillisEstimate
  };
  for (const f of ['docsExamined', 'keysExamined', 'indexName', 'keyPattern', 'indexBounds', 'filter']) {
    if (stage[f] !== undefined) keep[f] = compact(stage[f]);
  }
  if (stage.inputStage) keep.inputStage = stages(stage.inputStage);
  return keep;
}

function explain(title, cursorOrExplain) {
  const e = cursorOrExplain;
  const s = e.executionStats;
  print(`\n== ${title}`);
  printjson({
    executionStats: {
      executionSuccess: s.executionSuccess,
      nReturned: s.nReturned,
      executionTimeMillis: s.executionTimeMillis,
      totalKeysExamined: s.totalKeysExamined,
      totalDocsExamined: s.totalDocsExamined,
      executionStages: stages(s.executionStages)
    }
  });
}

function avgMs(runs, fn) {
  fn();
  const started = Date.now();
  for (let i = 0; i < runs; i++) fn();
  return ((Date.now() - started) / runs).toFixed(2);
}

print(`indexes on tags: ${JSON.stringify(db.tags.getIndexes().map(i => i.name))}`);

// Query 1 - tags_by_note: runs once per note in GET /api/notes (N+1) and in GET /api/notes/:id.
explain(
  'tags_by_note: db.tags.find({ note_id: 1 }, { _id: 0, name: 1 }).explain("executionStats")',
  db.tags.find({ note_id: 1 }, { _id: 0, name: 1 }).explain('executionStats')
);
print(`tags_by_note average over 200 runs (random note_id): ${avgMs(200, () =>
  db.tags.find({ note_id: 1 + Math.floor(Math.random() * 50000) }, { _id: 0, name: 1 }).toArray()
)} ms`);

// Query 2 - stats_tag_count: GET /api/stats for the biggest tenant (acme, 30,000
// notes). The app counts with countDocuments; the find below is the same
// filter, explained with the classic (readable) plan output.
const acmeIds = db.notes.find({ tenant_id: 1 }, { _id: 1 }).toArray().map(n => n._id);
explain(
  `stats_tag_count filter (acme, ${acmeIds.length} note ids): db.tags.find({ note_id: { $in: [...] } }, { _id: 0, note_id: 1 }).explain("executionStats")`,
  db.tags.find({ note_id: { $in: acmeIds } }, { _id: 0, note_id: 1 }).explain('executionStats')
);
print(`stats_tag_count countDocuments average over 20 runs: ${avgMs(20, () =>
  db.tags.countDocuments({ note_id: { $in: acmeIds } })
)} ms`);

// Cost of the fix - disk and write speed.
const st = db.tags.stats();
print('\n== tags collection size (bytes)');
printjson({ documents: st.count, dataSize: st.size, storageSize: st.storageSize, totalIndexSize: st.totalIndexSize, indexSizes: st.indexSizes });

// Times `rounds` rounds of `perRound` inserts made with insertMany(batch) or,
// for batch === 1, one insertOne per document.
function insertBench(label, rounds, perRound, batch) {
  const times = [];
  let next = BENCH_ID_START;
  for (let r = 0; r < rounds; r++) {
    const docs = [];
    for (let i = 0; i < perRound; i++) {
      docs.push({ _id: next++, note_id: 1 + Math.floor(Math.random() * 50000), name: 'bench' });
    }
    const started = Date.now();
    if (batch === 1) docs.forEach(d => db.tags.insertOne(d));
    else db.tags.insertMany(docs, { ordered: false });
    times.push(Date.now() - started);
  }
  db.tags.deleteMany({ _id: { $gte: BENCH_ID_START } });
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  print(`${label}: median ${median} ms per round (${(median / perRound).toFixed(3)} ms per document), rounds ${JSON.stringify(times)}`);
}

print('\n== insert timing (benchmark rows are deleted afterwards)');
insertBench('insertMany, 10,000 tags per call', 9, 10000, 10000);
insertBench('insertOne, 2,000 single inserts ', 9, 2000, 1);
