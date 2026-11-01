require('dotenv').config();
const mineflayer = require('mineflayer');

const bot = mineflayer.createBot({
  host: 'anarchia.gg',
  port: 25565,
  username: process.env.BOT_USERNAME,
  auth: 'offline',
  version: '1.20'
});

let loggedIn = false;

bot.once('spawn', () => {
  console.log('Bot połączył się z serwerem!');

  setTimeout(() => {
    if (process.env.BOT_PASSWORD) {
      bot.chat('/l ' + process.env.BOT_PASSWORD);
    }
  }, 3000);
});

bot.on('message', (message) => {
  console.log(message.toString());

  if (!loggedIn && message.toString().toLowerCase().includes('zalogowano')) {
    loggedIn = true;

    setTimeout(() => {
      bot.chat('/is');
    }, 2000);
  }
});

bot.on('kicked', reason => {
  console.log('Bot został rozłączony:', reason);
});

bot.on('error', error => {
  console.log('Błąd:', error.message);
});

bot.on('end', () => {
  console.log('Bot zakończył połączenie.');
});
