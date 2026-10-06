/* OPFS sync access handles are exclusive per file across tabs, so a second
copy of the game in the same browser profile cannot open the cache files the
first copy holds. The first copy keeps this lock for its lifetime; a copy that
cannot take it runs with in-memory storage instead. */
if (!ENVIRONMENT_IS_PTHREAD) {
  Module.haloStorageExclusive = true;
  Module.preRun = [].concat(Module.preRun || [], () => {
    if (!navigator.locks) return;
    addRunDependency("halo-storage-lock");
    navigator.locks.request("halo-storage", { ifAvailable: true }, lock => {
      Module.haloStorageExclusive = !!lock;
      removeRunDependency("halo-storage-lock");
      return lock && new Promise(() => {});
    });
  });
}
