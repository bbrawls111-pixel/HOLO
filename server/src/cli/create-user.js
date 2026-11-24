// Создание аккаунта. Для Neon: задайте DATABASE_URL (Vercel → Storage → .env.local).
import { one, q } from '../db.js';
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
const { n } = await one('SELECT COUNT(*)::int AS n FROM users');
if (n >= config.maxUsers) {
  console.log(`Регистрация закрыта: уже создано ${n} из ${config.maxUsers} аккаунтов.`);
  process.exit(1);
}
if (await one('SELECT 1 FROM users WHERE lower(login) = lower(?)', login)) {
  console.log('Такой логин уже есть.');
  process.exit(1);
}
await q('INSERT INTO users (login, pass_hash, nickname, created_at) VALUES (?, ?, ?, ?)', login, hashPassword(password), login, Date.now());
console.log(`Аккаунт «${login}» создан (${config.databaseUrl ? 'Neon' : 'локальная БД'}). Ник и аватар выбираются при первом входе.`);
process.exit(0);
