// Grant or remove admin rights on an existing account.
//
//   npm run admin -- list
//   npm run admin -- grant <username>
//   npm run admin -- revoke <username>
//
// Uses MONGODB_URI from .env (or the local database). On a host, run it from the host's shell/console.
// Changes apply immediately; the person doesn't need to log in again.

require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');

const [command, username] = process.argv.slice(2);
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/ArtPing';

async function main() {
  if (!['list', 'grant', 'revoke'].includes(command) || (command !== 'list' && !username)) {
    console.log('Usage:\n  npm run admin -- list\n  npm run admin -- grant <username>\n  npm run admin -- revoke <username>');
    process.exitCode = 1;
    return;
  }
  await mongoose.connect(mongoUri);
  const users = mongoose.connection.db.collection('users');

  if (command === 'list') {
    const admins = await users.find({ isAdmin: true }).project({ username: 1 }).toArray();
    console.log(admins.length ? `Admins: ${admins.map(a => a.username).join(', ')}` : 'No admins yet.');
    return;
  }

  const result = await users.updateOne(
    { $or: [{ usernameLower: username.toLowerCase() }, { username }] }, // older accounts may lack usernameLower until the server has run once
    { $set: { isAdmin: command === 'grant' } }
  );
  if (!result.matchedCount) {
    console.log(`No account named "${username}". Register it on the site first, then run this again.`);
    process.exitCode = 1;
  } else {
    console.log(command === 'grant' ? `${username} is now an admin.` : `${username} is no longer an admin.`);
  }
}

main()
  .catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
