/**
 * 同步码「保险箱」：用**密码派生密钥**把同步码加密后再存到账号里。
 *
 * 为什么这么做：服务端只能存/取密文，**永远解不开**。
 * 数据库泄露时，攻击者拿到的是一堆没有密码就打不开的密文 ——
 * 用户的课文库和收藏不会因为服务端被拖库而连坐。
 *
 * 代价：忘记密码 = 同步码解不开。所以找回密码的邮件里明确写了这一点，
 * 界面上也要提醒用户把同步码抄下来。
 *
 * 算法：PBKDF2-SHA256 派生 AES-GCM-256 密钥，密文连同 salt/iv 一起存。
 *
 * 迭代数取 210000 —— **故意和服务端密码哈希同量级**。
 * 两边都是同一密码的 PBKDF2，取不一样只会让攻击者去打弱的那个；
 * 保持一致就没有短板可言，也不会让手机上登录多等几秒。
 */

const ITERATIONS = 210000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};
const fromB64 = (s) => Uint8Array.from(atob(String(s)), (c) => c.charCodeAt(0));

/** 密码 + salt → AES-GCM 密钥（不可导出） */
async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * 加密一段文本。
 * @returns {Promise<{salt:string, iv:string, c:string}>} 三个字段都是 base64
 */
export async function sealText(plain, password) {
  if (!plain) throw new Error('没有可加密的内容');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12)); // AES-GCM 推荐 96 bit
  const key = await deriveKey(password, salt);
  const c = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(String(plain)));
  return { salt: toB64(salt), iv: toB64(iv), c: toB64(c) };
}

/**
 * 解密。密码不对 / 密文损坏时返回 null（不抛错 —— 调用方只需知道"解不开"）。
 * @returns {Promise<string|null>}
 */
export async function openText(box, password) {
  try {
    if (!box || !box.salt || !box.iv || !box.c) return null;
    const key = await deriveKey(password, fromB64(box.salt));
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.c)
    );
    return dec.decode(plain);
  } catch {
    return null;
  }
}

/** 形状校验：服务端也做一遍，这里先拦一次，省一次往返。 */
export const isBox = (v) => Boolean(v) && typeof v === 'object'
  && typeof v.salt === 'string' && typeof v.iv === 'string' && typeof v.c === 'string'
  && v.salt.length > 0 && v.iv.length > 0 && v.c.length > 0;
