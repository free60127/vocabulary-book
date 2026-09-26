/**
 * 把 v 写成 o 的**自有**可枚举属性，返回 o。
 *
 * 为什么不用 `o[k] = v`：k 来自 JSON.parse（备份文件 / 云同步快照 / localStorage），
 * 而 JSON.parse 会把数据里的 `"__proto__"` 键建成**自有属性** —— 普通赋值对它不建键，
 * 而是触发 Object.prototype 的 setter 把 o 的**原型整个换掉**，记录本身静默消失。
 * （实测：mergeSchedules 吃到带 __proto__ 键的恶意备份即被替换原型。）
 * defineProperty 对任何键（包括字面 __proto__）都创建自有属性，序列化也能原样往返。
 */
export function putKey(o, k, v) {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  return o;
}
