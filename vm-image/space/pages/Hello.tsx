export default function Hello() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 p-8">
      <p className="text-sm uppercase tracking-[0.25em] text-emerald-400">Nimbus Space</p>
      <h1 className="text-5xl font-semibold leading-tight">
        Hello from <span className="text-cyan-300">React</span>
      </h1>
      <p className="max-w-xl text-lg text-slate-400">
        Tailwind CSS 4 + Vite HMR. Diese Page liegt unter <code className="text-slate-200">pages/Hello.tsx</code>
        und wird dynamisch über die Space-Route geladen.
      </p>
      <a
        className="inline-flex w-fit rounded-xl bg-cyan-400 px-4 py-2 font-medium text-slate-950"
        href="/__health"
      >
        Health prüfen
      </a>
    </main>
  );
}
