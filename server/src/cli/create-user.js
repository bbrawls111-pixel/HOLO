import { db } from '../db.js';
import { config } from '../config.js';
import { hashPassword } from '../auth.js';

const [login, password] = process.argv.slice(2);
if (!login || !password) {
  console.log('Использование: npm run create-user -- <логин> <пароль>');
  process.exit(1);
}
if (password.length < 8) {
  console.log('Пароль должен быть не короче 8 символов.');
  process.exit(1);
}
const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (count >= config.maxUsers) {
  console.log(`Регистрация закрыта: уже создано ${count} из ${config.maxUsers} аккаунтов.`);
  process.exit(1);
}
if (db.prepare('SELECT 1 FROM users WHERE login = ?').get(login)) {
  console.log('Такой логин уже есть.');
  process.exit(1);
}
db.prepare('INSERT INTO users (login, pass_hash, nickname, created_at) VALUES (?, ?, ?, ?)').run(
  login,
  hashPassword(password),
  login,
  Date.now(),
);
console.log(`Аккаунт «${login}» создан. Ник и аватар выбираются при первом входе.`);
