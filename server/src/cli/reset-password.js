import { one, q } from '../db.js';
import { hashPassword } from '../auth.js';

const [login, password] = process.argv.slice(2);
if (!login || !password || password.length < 8) {
  console.log('Использование: npm run reset-password -- <логин> <новый пароль (от 8 символов)>');
  process.exit(1);
}
const user = await one('SELECT id FROM users WHERE lower(login) = lower(?)', login);
if (!user) {
  console.log('Пользователь не найден.');
  process.exit(1);
}
await q('UPDATE users SET pass_hash = ? WHERE id = ?', hashPassword(password), user.id);
await q('DELETE FROM sessions WHERE user_id = ?', user.id);
console.log('Пароль обновлён, все сессии пользователя завершены.');
process.exit(0);
