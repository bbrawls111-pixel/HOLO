import { avatarPath, useBinaryUrl } from '../api';
import type { User } from '../types';
import { gradientFor, initials } from '../util';
import styles from './Avatar.module.css';

interface Props {
  user: Pick<User, 'id' | 'nickname' | 'hasAvatar' | 'avatarVersion'> & { online?: boolean };
  size?: number;
  status?: boolean;
  srcOverride?: string | null;
}

export function Avatar({ user, size = 36, status = false, srcOverride }: Props) {
  const fetched = useBinaryUrl(srcOverride ? null : avatarPath(user));
  const src = srcOverride ?? fetched;
  const [a, b] = gradientFor(user.id);
  return (
    <div className={styles.wrap} style={{ width: size, height: size }}>
      {src ? (
        <img className={styles.img} src={src} alt="" draggable={false} />
      ) : (
        <div className={styles.fallback} style={{ background: `linear-gradient(135deg, ${a}, ${b})`, fontSize: size * 0.38 }}>
          {initials(user.nickname)}
        </div>
      )}
      {status && (
        <span
          className={styles.dot}
          data-online={user.online ? '1' : '0'}
          style={{ width: Math.max(9, size * 0.28), height: Math.max(9, size * 0.28) }}
        />
      )}
    </div>
  );
}
