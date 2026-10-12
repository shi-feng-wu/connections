// Tiny typed-by-convention event emitter shared by every subsystem.
export class Emitter {
  #handlers = new Map();

  on(type, fn) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
    this.#handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    this.#handlers.get(type)?.delete(fn);
  }

  emit(type, detail) {
    for (const fn of this.#handlers.get(type) ?? []) fn(detail);
  }
}
