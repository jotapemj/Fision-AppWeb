// Mini arnes: test(nombre, fn). fn devuelve texto con lo medido, o 'skip'.
export const tests = [];
export const test = (name, fn) => tests.push({ name, fn });

export function expect(cond, msg) { if (!cond) throw new Error(msg); }
export function near(got, want, tol, what) {
  if (!(Math.abs(got - want) <= tol)) throw new Error(`${what}: ${got} (esperado ${want} ± ${tol})`);
}
