import { db } from '../db.js';
import { hashPassword } from '../auth.js';

const [login, password] = process.argv.slice(2);
if (!login || !password || password.length < 8) {
  console.log('Использование: npm run reset-password -- <логин> <новый пароль (от 8 символов)>');
  process.exit(1);
}
const user = db.prepare('SELECT id FROM users WHERE login = ?').get(login);
if (!user) {
  console.log('Пользователь не найден.');
  process.exit(1);
}
db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
console.log('Пароль обновлён, все сессии пользователя завершены.');
