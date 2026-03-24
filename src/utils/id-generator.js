/**
 * @file UUID 生成工具
 * @description 提供 UUID v4 和 ULID 生成功能
 */

/**
 * 生成 UUID v4
 * @returns {string} 格式为 xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 */
export function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * 生成 ULID（通用唯一词典排序标识符）
 * 格式: 26 位 Crockford Base32 字符
 *   前 10 位: 时间戳 (48 bit)
 *   后 16 位: 随机数 (80 bit)
 * @returns {string}
 */
export function generateULID() {
  const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

  // 编码时间戳为 10 位字符
  let ts = Date.now();
  let time = '';
  for (let i = 9; i >= 0; i--) {
    time = ENCODING[ts % 32] + time;
    ts = Math.floor(ts / 32);
  }

  // 生成 16 位随机字符
  let random = '';
  for (let i = 0; i < 16; i++) {
    random += ENCODING[Math.floor(Math.random() * 32)];
  }

  return time + random;
}

/**
 * 生成客户端 ID（格式: client_01{ULID}）
 * @returns {string}
 */
export function generateClientId() {
  return `client_01${generateULID()}`;
}
