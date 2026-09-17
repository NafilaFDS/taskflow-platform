// Task 34 - fix Problem 3 (missing index on tags.note_id).
//
// MongoDB equivalent of: CREATE INDEX idx_tags_note_id ON tags (note_id);
//
// Run after seed/seed.js (the seeder drops the tags collection, which drops
// this index too, restoring the deliberately broken baseline):
//
//   docker compose exec -T mongodb sh -c \
//     'cat > /tmp/fix.js && mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin taskflow /tmp/fix.js' \
//     < seed/fix-idx-tags-note-id.js

const started = Date.now();
const name = db.tags.createIndex({ note_id: 1 }, { name: 'idx_tags_note_id' });
print(`${name} ready in ${Date.now() - started} ms`);
printjson(db.tags.getIndexes().map(i => ({ name: i.name, key: i.key })));
