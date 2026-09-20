function WaitingCat() {
  return (
    <svg
      aria-hidden="true"
      className="waiting-cat"
      fill="none"
      viewBox="0 0 260 210"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        className="waiting-cat__fill"
        d="M78 111c0-37 22-66 52-66s52 29 52 66v36H78v-36Z"
      />
      <path
        className="waiting-cat__line"
        d="M83 82 68 52l34 14M177 82l15-30-34 14M78 111c0-37 22-66 52-66s52 29 52 66"
      />
      <path className="waiting-cat__line" d="M111 101c4-4 10-4 14 0M149 101c-4-4-10-4-14 0" />
      <path className="waiting-cat__line" d="M126 115h8l-4 5-4-5ZM130 120v8m0 0c-6 0-10-2-12-6m12 6c6 0 10-2 12-6" />
      <path className="waiting-cat__line" d="m105 114-30-5m30 14-32 4m82-13 30-5m-30 14 32 4" />
      <path className="waiting-cat__line" d="M78 126c-24 5-33 22-20 35 8 8 24 5 26-6" />
      <path
        className="waiting-cat__bowl"
        d="M67 148h126l-12 36c-2 7-9 12-17 12H96c-8 0-15-5-17-12l-12-36Z"
      />
      <path className="waiting-cat__line" d="M67 148h126m-114 36h102" />
      <path className="waiting-cat__empty" d="M109 169h42" />
    </svg>
  );
}

export function App() {
  return (
    <main className="placeholder">
      <picture className="max-logo">
        <source media="(prefers-color-scheme: dark)" srcSet="/assets/max-logo-on-dark.svg" />
        <img src="/assets/max-logo-on-light.svg" alt="MAX" />
      </picture>

      <section className="placeholder__content">
        <h1>
          <strong>Спланируй свой досуг</strong>
          <span>в мини-приложении MAX</span>
        </h1>

        <WaitingCat />
        <p>тут пока ничего нет</p>
      </section>
    </main>
  );
}
