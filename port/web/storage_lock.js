/* OPFS sync access handles are exclusive per file across tabs, so a second
copy of the game in the same browser profile cannot open the cache files the
first copy holds. The first copy keeps this lock for its lifetime; a copy that
cannot take it runs with in-memory storage instead. */
if (!ENVIRONMENT_IS_PTHREAD) {
  Module.haloStorageExclusive = true;
  Module.preRun = [].concat(Module.preRun || [], () => {
    if (!navigator.locks) return;
    var answered = false;
    function answer(exclusive) {
      if (answered) return;
      answered = true;
      Module.haloStorageExclusive = exclusive;
      removeRunDependency("halo-storage-lock");
    }
    addRunDependency("halo-storage-lock");
    /* A refused request (an opaque-origin frame, for instance) must still
    release startup; it keeps the behaviour of a browser without Web Locks. */
    try {
      navigator.locks.request("halo-storage", { ifAvailable: true }, lock => {
        answer(!!lock);
        return lock && new Promise(() => {});
      }).catch(() => answer(true));
    } catch (error) {
      answer(true);
    }
  });
}
