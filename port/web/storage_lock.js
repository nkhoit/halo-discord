/* OPFS sync access handles are exclusive per file across tabs, so a second
copy of the game in the same browser profile cannot open the cache files the
first copy holds. The first copy keeps this lock for its lifetime; a copy that
cannot take it runs with in-memory storage instead. */
if (!ENVIRONMENT_IS_PTHREAD) {
  Module.haloStorageExclusive = true;
  /* (the hosted page's start-up report, server/client/hosted.js) the storage
  this copy uses, and what the lock request said */
  var reportStorage = (exclusive, lock) => {
    if (typeof window !== "undefined") {
      (window.HaloBootEvents = window.HaloBootEvents || []).push(
        ["storage", performance.now(), { mode: exclusive ? "opfs" : "memory", lock: lock }]);
    }
  };
  Module.preRun = [].concat(Module.preRun || [], () => {
    if (!navigator.locks) {
      reportStorage(true, "none");
      return;
    }
    var answered = false;
    function answer(exclusive, lock) {
      if (answered) return;
      answered = true;
      Module.haloStorageExclusive = exclusive;
      reportStorage(exclusive, lock);
      removeRunDependency("halo-storage-lock");
    }
    addRunDependency("halo-storage-lock");
    /* A refused request (an opaque-origin frame, for instance) must still
    release startup; it keeps the behaviour of a browser without Web Locks. */
    try {
      navigator.locks.request("halo-storage", { ifAvailable: true }, lock => {
        answer(!!lock, lock ? "granted" : "held");
        return lock && new Promise(() => {});
      }).catch(() => answer(true, "refused"));
    } catch (error) {
      answer(true, "refused");
    }
  });
}
