// Transient toast appended to <body>, outside the React tree (fire-and-forget overlay).

let toastTimer: ReturnType<typeof setTimeout>;

export function showToast(msg: string): void {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className =
      'fixed left-1/2 bottom-6 -translate-x-1/2 rounded-full bg-zinc-100 px-4 py-2 text-sm font-bold text-zinc-900 opacity-0 transition-opacity pointer-events-none';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.remove('opacity-0');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t!.classList.add('opacity-0'), 1600);
}
