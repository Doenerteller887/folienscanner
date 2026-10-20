// Lädt OpenCV.js (lib/opencv.js, WASM ist eingebettet) genau einmal.
// Das Modul-Objekt hat eine eigene `then`-Methode, die sich selbst zurückgibt –
// direktes `await cv` würde endlos laufen. Deshalb wird `then` vor dem Auflösen entfernt.

let promise = null;

export function loadCV(src = new URL('../lib/opencv.js', import.meta.url).href) {
  if (promise) return promise;
  promise = new Promise((resolve, reject) => {
    const finish = (mod) => {
      if (mod && typeof mod.then === 'function') delete mod.then;
      window.cv = mod;
      resolve(mod);
    };
    const attach = () => {
      const mod = window.cv;
      if (!mod) return reject(new Error('OpenCV konnte nicht geladen werden'));
      if (mod.Mat) return finish(mod);
      if (typeof mod.then === 'function') mod.then(finish);
      else mod.onRuntimeInitialized = () => finish(mod);
    };
    if (window.cv) return attach();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = attach;
    s.onerror = () => reject(new Error('OpenCV konnte nicht geladen werden'));
    document.head.appendChild(s);
  });
  return promise;
}
