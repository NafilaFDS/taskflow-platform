// Seeder for the multi-tenant Notes API (Scenario B).
//
// Runs inside the mongodb container with mongosh, so credentials never leave
// the container:
//
//   docker compose exec -T mongodb sh -c \
//     'cat > /tmp/seed.js && mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin taskflow /tmp/seed.js' \
//     < seed/seed.js
//
// Creates 5 tenants, 50,000 notes (acme gets 30,000, the rest 5,000 each) and
// 150,000 tags. Re-running replaces the previous seed. Legacy B2 notes (created
// through /notes, no tenant_id) are left untouched.
//
// Deliberately NOT created (the app's deliberate problems depend on this):
//   - no index on tags.note_id    (Problem 3, fixed in Task 34 by
//                                  seed/fix-idx-tags-note-id.js - run it after
//                                  seeding to get the fixed state back)
//   - no index on notes.body      (Problem 2)

const TENANTS = [
  { _id: 1, slug: 'acme', notes: 30000 },
  { _id: 2, slug: 'globex', notes: 5000 },
  { _id: 3, slug: 'initech', notes: 5000 },
  { _id: 4, slug: 'umbrella', notes: 5000 },
  { _id: 5, slug: 'hooli', notes: 5000 }
];
const TOTAL_NOTES = TENANTS.reduce((sum, t) => sum + t.notes, 0);
const TOTAL_TAGS = 150000;
const BATCH = 5000;

const WORDS = [
  'invoice', 'meeting', 'roadmap', 'deploy', 'budget', 'customer', 'bug',
  'release', 'design', 'review', 'backup', 'incident', 'onboarding', 'sprint',
  'contract', 'feedback', 'metrics', 'launch', 'hiring', 'security', 'refactor',
  'migration', 'support', 'pricing', 'report', 'travel', 'training', 'audit'
];

function word() {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}

function hex32() {
  let s = '';
  for (let i = 0; i < 32; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  return s;
}

const started = Date.now();

db.tenants.drop();
db.tags.drop();
db.notes.deleteMany({ tenant_id: { $exists: true } });
db.counters.drop();

db.tenants.insertMany(TENANTS.map(t => ({ _id: t._id, slug: t.slug })));
db.tenants.createIndex({ slug: 1 }, { unique: true });

// Uneven, shuffled tenant assignment so every tenant's notes are spread across
// the whole collection (like rows inserted over time by many customers).
const owners = [];
TENANTS.forEach(t => { for (let i = 0; i < t.notes; i++) owners.push(t._id); });
for (let i = owners.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [owners[i], owners[j]] = [owners[j], owners[i]];
}

const now = Date.now();
for (let start = 1; start <= TOTAL_NOTES; start += BATCH) {
  const docs = [];
  for (let id = start; id < start + BATCH && id <= TOTAL_NOTES; id++) {
    docs.push({
      _id: id,
      tenant_id: owners[id - 1],
      title: `Note ${id}`,
      body: `${word()} ${word()} ${word()} ${word()} ${hex32()} ${hex32()}`,
      created_at: new Date(now - Math.floor(Math.random() * 365 * 24 * 3600 * 1000))
    });
  }
  db.notes.insertMany(docs, { ordered: false });
}

for (let start = 1; start <= TOTAL_TAGS; start += BATCH) {
  const docs = [];
  for (let id = start; id < start + BATCH && id <= TOTAL_TAGS; id++) {
    docs.push({ _id: id, note_id: 1 + Math.floor(Math.random() * TOTAL_NOTES), name: word() });
  }
  db.tags.insertMany(docs, { ordered: false });
}

// Next ids for POST /api/notes (the equivalent of a SERIAL sequence).
db.counters.insertMany([
  { _id: 'notes', seq: TOTAL_NOTES },
  { _id: 'tags', seq: TOTAL_TAGS }
]);

print(`seeded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
TENANTS.forEach(t => print(`  ${t.slug.padEnd(9)} notes=${db.notes.countDocuments({ tenant_id: t._id })}`));
print(`  tags=${db.tags.countDocuments()}  indexes on tags: ${JSON.stringify(db.tags.getIndexes().map(i => i.name))}`);
