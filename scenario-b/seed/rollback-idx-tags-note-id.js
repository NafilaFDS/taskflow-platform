// Rollback for seed/fix-idx-tags-note-id.js: drops idx_tags_note_id, putting
// Problem 3 back. Used only to re-capture the "before" explain output live;
// run the fix again afterwards.
//
//   docker compose exec -T mongodb sh -c \
//     'cat > /tmp/rollback.js && mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin taskflow /tmp/rollback.js' \
//     < seed/rollback-idx-tags-note-id.js

db.tags.dropIndex('idx_tags_note_id');
printjson(db.tags.getIndexes().map(i => i.name));
