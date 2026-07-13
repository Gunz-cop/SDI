globalThis.fetch = () => {
  throw new Error("External validation forbids network access after installation.");
};
