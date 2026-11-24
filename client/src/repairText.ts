/*
 * Восстановление «кракозябр»: UTF-8 текст, ошибочно прочитанный как Windows-1251
 * («Структура» → «РЎС‚СЂСѓРєС‚СѓСЂР°»). Переводим символы обратно в байты cp1251
 * и декодируем их как UTF-8. Если результат не похож на нормальный текст — оставляем как было.
 */
let reverse: Map<string, number> | null = null;

function cp1251Reverse() {
  if (reverse) return reverse;
  reverse = new Map();
  const dec = new TextDecoder('windows-1251');
  for (let b = 0x80; b <= 0xff; b++) reverse.set(dec.decode(new Uint8Array([b])), b);
  reverse.set('\u0098', 0x98); // в cp1251 байт 0x98 не определён
  return reverse;
}

const MOJIBAKE = /[РС][\u0080-¿Ђ-Џђ-џ‐-™Ѐ-џ]/;

export function looksBroken(s: string | undefined): boolean {
  if (!s) return false;
  const hits = s.match(new RegExp(MOJIBAKE.source, 'g'))?.length ?? 0;
  return hits >= 2 && /[ЃЌЋЏђ‚„…†‡€‰‹›‘’“”•–—™љњќћџЎўЈ¤Ґ¦§©Є«¬®Ї°±Ііґµ¶·№є»јЅѕї]/.test(s);
}

export function repairText(s: string): string {
  if (!looksBroken(s)) return s;
  const map = cp1251Reverse();
  const bytes: number[] = [];
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code < 0x80) bytes.push(code);
    else {
      const b = map.get(ch);
      if (b === undefined) return s;
      bytes.push(b);
    }
  }
  try {
    const fixed = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    return /[а-яё]/i.test(fixed) ? fixed : s;
  } catch {
    return s;
  }
}
