/* Browser transports for the browser socket adapter.

   The public API is window.HaloWebTransport.  Signalling is deliberately
   supplied by the page: this module owns peer connections and DataChannels,
   but does not know whether offers travel through a Worker, a local test
   harness, or another signalling service.  With configure({ transport:
   'relay' }) the same peers travel through a WebSocket relay (server/)
   instead, and take no signals. */

addToLibrary({
  $HaloWebTransportRuntime__postset: 'HaloWebTransportRuntime.install();',
  $HaloWebTransportRuntime: {
    RELIABLE_LABEL: 'halo-reliable-v1',
    UNRELIABLE_LABEL: 'halo-unreliable-v1',
    RELIABLE_HIGH_WATER: 1024 * 1024,
    UNRELIABLE_HIGH_WATER: 256 * 1024,
    RELIABLE_QUEUE_LIMIT: 4 * 1024 * 1024,
    UNRELIABLE_QUEUE_LIMIT: 512 * 1024,
    UNRELIABLE_PACKET_LIMIT: 256,
    REMOTE_CANDIDATE_LIMIT: 64,
    peersById: new Map(),
    peersByAddress: new Map(),
    registrationChain: null,
    options: {
      iceServers: [],
      onSignal: null,
      onStateChange: null,
      onError: null,
      transport: 'webrtc',
      relay: null,
    },
    pumpTimer: 0,
    pumpPosted: false,
    pumpChannel: null,
    idlePumpRetries: 0,
    /* Retries that make no progress (a busy or full socket in Wasm) stop
       spinning after this many and fall back to a timer. */
    IDLE_PUMP_RETRY_LIMIT: 32,
    pumping: false,
    /* ?netstats=1: local measurement only, never sent anywhere. */
    netstatsEnabled: false,
    netstatsWindow: null,
    netstatsHistory: [],
    NETSTATS_HISTORY_WINDOWS: 720,
    NETSTATS_GAP_SAMPLES: 8192,
    NETSTATS_LOG_MILLISECONDS: 5000,

    normalizeAddress: function(address) {
      return address >>> 0;
    },

    addressText: function(address) {
      address = address >>> 0;
      return [address & 255, (address >>> 8) & 255,
        (address >>> 16) & 255, (address >>> 24) & 255].join('.');
    },

    identifierBytes: function(value) {
      if (value instanceof Uint8Array && value.length === 6) {
        return new Uint8Array(value);
      }
      if (typeof value !== 'string' || !/^[0-9a-fA-F]{12}$/.test(value)) {
        throw new TypeError('remoteIdentifier must be 12 hexadecimal characters');
      }
      var bytes = new Uint8Array(6);
      for (var index = 0; index < bytes.length; index++) {
        bytes[index] = parseInt(value.slice(index * 2, index * 2 + 2), 16);
      }
      return bytes;
    },

    identifierText: function(bytes) {
      var text = '';
      for (var index = 0; index < bytes.length; index++) {
        text += bytes[index].toString(16).padStart(2, '0');
      }
      return text;
    },

    moduleFunction: function(name) {
      var fn = Module['_' + name];
      if (typeof fn !== 'function') {
        throw new Error('Halo WebAssembly networking is not ready');
      }
      return fn;
    },

    localIdentifier: function() {
      var pointer = HaloWebTransportRuntime.moduleFunction(
        'web_net_remote_local_identifier')();
      return HaloWebTransportRuntime.identifierText(
        HEAPU8.slice(pointer, pointer + 6));
    },

    callWhenUnlocked: async function(fn, timeoutMilliseconds) {
      var deadline = performance.now() + (timeoutMilliseconds || 5000);
      for (;;) {
        var result = fn();
        if (result) return result;
        if (performance.now() >= deadline) {
          throw new Error('Halo networking stayed busy for too long');
        }
        await new Promise(function(resolve) { setTimeout(resolve, 1); });
      }
    },

    registerPeer: async function(identifier) {
      var runtime = HaloWebTransportRuntime;
      if (!runtime.registrationChain ||
          typeof runtime.registrationChain.then !== 'function') {
        runtime.registrationChain = Promise.resolve();
      }
      var operation = runtime.registrationChain.then(function() {
        var ingress = runtime.moduleFunction('web_net_remote_ingress_buffer')();
        HEAPU8.set(identifier, ingress);
        return runtime.callWhenUnlocked(function() {
          return runtime.moduleFunction('web_net_remote_add_peer')(
            ingress, identifier.length) >>> 0;
        });
      });
      runtime.registrationChain = operation.catch(function() {});
      return operation;
    },

    removePeerFromWasm: async function(address) {
      var runtime = HaloWebTransportRuntime;
      if (!runtime.registrationChain ||
          typeof runtime.registrationChain.then !== 'function') {
        runtime.registrationChain = Promise.resolve();
      }
      var operation = runtime.registrationChain.then(function() {
        return runtime.callWhenUnlocked(function() {
          return runtime.moduleFunction('web_net_remote_remove_peer')(address);
        });
      });
      runtime.registrationChain = operation.catch(function() {});
      try {
        await operation;
      } catch (error) {
        runtime.reportError(null, error);
      }
    },

    reportError: function(record, error) {
      var callback = HaloWebTransportRuntime.options.onError;
      if (typeof callback === 'function') {
        try {
          callback({
            peerId: record ? record.peerId : null,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        } catch (callbackError) {
          console.error('Halo web transport error callback failed', callbackError);
        }
      } else {
        console.error('Halo web transport', error);
      }
    },

    emitState: function(record, state, detail) {
      if (record.lastPublicState === state && !detail) return;
      record.lastPublicState = state;
      var callback = HaloWebTransportRuntime.options.onStateChange;
      if (typeof callback === 'function') {
        try {
          callback({
            peerId: record.peerId,
            state: state,
            detail: detail || null,
            address: record.addressText,
          });
        } catch (error) {
          HaloWebTransportRuntime.reportError(record, error);
        }
      }
    },

    emitSignal: function(record, signal) {
      var callback = HaloWebTransportRuntime.options.onSignal;
      if (typeof callback !== 'function') {
        HaloWebTransportRuntime.reportError(record,
          new Error('No WebRTC signalling callback is configured'));
        return;
      }
      Promise.resolve().then(function() {
        if (record.removed) return;
        return callback({ peerId: record.peerId, signal: signal });
      }).catch(function(error) {
        HaloWebTransportRuntime.reportError(record, error);
      });
    },

    channelWriteable: function(channel, highWater) {
      return !!channel && channel.readyState === 'open' &&
        channel.bufferedAmount <= highWater;
    },

    channelsReady: function(record) {
      if (record.relay) return HaloWebTransportRuntime.relayReady(record);
      return !!record.reliable && record.reliable.readyState === 'open' &&
        !!record.unreliable && record.unreliable.readyState === 'open';
    },

    /* Hidden pages run chained timers about once a second, which would hold
       received packets back from the game.  Message events are not
       throttled, so pumps are posted through a MessageChannel. */
    schedulePump: function() {
      var runtime = HaloWebTransportRuntime;
      if (runtime.pumpPosted) return;
      if (!runtime.pumpChannel) {
        runtime.pumpChannel = new MessageChannel();
        runtime.pumpChannel.port1.onmessage = function() {
          runtime.pumpPosted = false;
          runtime.pump();
        };
      }
      runtime.pumpPosted = true;
      runtime.pumpChannel.port2.postMessage(null);
    },

    scheduleIdlePumpRetry: function() {
      var runtime = HaloWebTransportRuntime;
      if (++runtime.idlePumpRetries <= runtime.IDLE_PUMP_RETRY_LIMIT) {
        runtime.schedulePump();
        return;
      }
      /* New packets and channel events still post pumps immediately. */
      if (runtime.pumpTimer || runtime.pumpPosted) return;
      runtime.pumpTimer = setTimeout(function() {
        runtime.pumpTimer = 0;
        runtime.pump();
      }, 4);
    },

    syncPeerState: function(record) {
      if (!record || record.removed) return;
      var runtime = HaloWebTransportRuntime;
      var connected = runtime.channelsReady(record);
      var reliableWriteable;
      var unreliableWriteable;
      if (record.relay) {
        reliableWriteable = connected && !record.relayBlocked;
        /* Late datagrams are dropped at send time instead (relaySend). */
        unreliableWriteable = connected;
      } else {
        reliableWriteable = connected && runtime.channelWriteable(
          record.reliable, runtime.RELIABLE_HIGH_WATER);
        unreliableWriteable = connected && runtime.channelWriteable(
          record.unreliable, runtime.UNRELIABLE_HIGH_WATER);
      }
      var result;
      try {
        result = runtime.moduleFunction('web_net_remote_set_peer_state')(
          record.address, connected ? 1 : 0,
          reliableWriteable ? 1 : 0, unreliableWriteable ? 1 : 0);
      } catch (error) {
        runtime.reportError(record, error);
        return;
      }
      if (result === 0) {
        record.needsStateSync = true;
        runtime.scheduleIdlePumpRetry();
        return;
      }
      record.needsStateSync = false;
      if (result < 0) return;
      if (connected) runtime.emitState(record, 'connected');
    },

    configureChannel: function(record, channel, reliable) {
      var runtime = HaloWebTransportRuntime;
      var expected = reliable ? runtime.RELIABLE_LABEL : runtime.UNRELIABLE_LABEL;
      if (channel.label !== expected) {
        channel.close();
        runtime.failPeer(record, new Error('Unexpected DataChannel: ' + channel.label));
        return;
      }
      if ((reliable && (!channel.ordered || channel.maxRetransmits !== null)) ||
          (!reliable && (channel.ordered || channel.maxRetransmits !== 0))) {
        channel.close();
        runtime.failPeer(record, new Error('Peer offered incompatible DataChannel settings'));
        return;
      }
      if ((reliable && record.reliable) || (!reliable && record.unreliable)) {
        channel.close();
        runtime.failPeer(record, new Error('Peer opened a duplicate DataChannel'));
        return;
      }
      channel.binaryType = 'arraybuffer';
      channel.bufferedAmountLowThreshold = reliable ?
        runtime.RELIABLE_HIGH_WATER / 2 : runtime.UNRELIABLE_HIGH_WATER / 2;
      if (reliable) record.reliable = channel;
      else record.unreliable = channel;
      channel.onopen = function() {
        record.needsStateSync = true;
        runtime.syncPeerState(record);
        runtime.schedulePump();
      };
      channel.onclose = function() {
        if (!record.removed) {
          runtime.failPeer(record, new Error(
            (reliable ? 'Reliable' : 'Unreliable') + ' DataChannel closed'));
        }
      };
      channel.onerror = function(event) {
        runtime.reportError(record, new Error(
          (reliable ? 'Reliable' : 'Unreliable') + ' DataChannel failed'));
      };
      channel.onbufferedamountlow = function() {
        record.needsStateSync = true;
        runtime.syncPeerState(record);
      };
      channel.onmessage = function(event) {
        runtime.receiveChannelMessage(record, reliable, event.data);
      };
      if (channel.readyState === 'open') {
        record.needsStateSync = true;
        runtime.syncPeerState(record);
      }
    },

    receiveChannelMessage: function(record, reliable, value) {
      var runtime = HaloWebTransportRuntime;
      if (record.removed) return;
      if (!(value instanceof ArrayBuffer)) {
        runtime.failPeer(record, new Error('DataChannel sent a non-binary message'));
        return;
      }
      var bytes = new Uint8Array(value);
      if (bytes.byteLength < 12 || bytes.byteLength > 16396) {
        runtime.failPeer(record, new Error('DataChannel frame has an invalid size'));
        return;
      }
      if (reliable) {
        if (record.reliableQueuedBytes + bytes.byteLength > runtime.RELIABLE_QUEUE_LIMIT) {
          runtime.failPeer(record, new Error('Reliable receive queue overflow'));
          return;
        }
        record.reliableQueue.push(bytes);
        record.reliableQueuedBytes += bytes.byteLength;
      } else {
        if (record.unreliableQueue.length >= runtime.UNRELIABLE_PACKET_LIMIT ||
            record.unreliableQueuedBytes + bytes.byteLength > runtime.UNRELIABLE_QUEUE_LIMIT) {
          /* UDP is best effort: discard the newest update when the game is
             not keeping up, rather than adding input latency. */
          record.droppedDatagrams++;
          return;
        }
        record.unreliableQueue.push(bytes);
        record.unreliableQueuedBytes += bytes.byteLength;
      }
      if (record.netstats) runtime.netstatsArrival(record.netstats[reliable ? 0 : 1], bytes.byteLength);
      runtime.idlePumpRetries = 0;
      runtime.schedulePump();
    },

    netstatsChannel: function() {
      return { frames: 0, bytes: 0, last: 0, gaps: [], gapMax: 0, over150: 0, over300: 0 };
    },

    netstatsArrival: function(channel, length) {
      var now = performance.now();
      if (channel.last) {
        var gap = now - channel.last;
        if (channel.gaps.length < HaloWebTransportRuntime.NETSTATS_GAP_SAMPLES) channel.gaps.push(gap);
        if (gap > channel.gapMax) channel.gapMax = gap;
        if (gap > 150) channel.over150++;
        if (gap > 300) channel.over300++;
      }
      channel.last = now;
      channel.frames++;
      channel.bytes += length;
    },

    netstatsTakeChannel: function(channel, seconds) {
      var gaps = channel.gaps.slice().sort(function(a, b) { return a - b; });
      var percentile = function(fraction) {
        return gaps.length ? +gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * fraction))].toFixed(1) : null;
      };
      var result = {
        framesPerSecond: +(channel.frames / seconds).toFixed(1),
        bytesPerSecond: Math.round(channel.bytes / seconds),
        gapP50Ms: percentile(0.5),
        gapP99Ms: percentile(0.99),
        gapMaxMs: +channel.gapMax.toFixed(1),
        gapsOver150Ms: channel.over150,
        gapsOver300Ms: channel.over300,
      };
      channel.frames = 0;
      channel.bytes = 0;
      channel.gaps = [];
      channel.gapMax = 0;
      channel.over150 = 0;
      channel.over300 = 0;
      return result;
    },

    netstatsGame: function() {
      var game = {};
      var values = Module['_platform_web_netstats'];
      if (typeof values === 'function') {
        var index = values() >>> 3;
        game.ticks = HEAPF64[index];
        game.ownCorrections = HEAPF64[index + 1];
        game.ownCorrectionMaxUnits = +HEAPF64[index + 2].toFixed(2);
        game.rejectedPredictions = HEAPF64[index + 3];
        game.ownAimCorrections = HEAPF64[index + 4];
        game.ownAimCorrectionMaxDegrees = +HEAPF64[index + 5].toFixed(1);
        game.ownSeatCorrections = HEAPF64[index + 6];
        game.hostStateAgeTicks = HEAPF64[index + 98];
        game.hostStateAgeMaxTicks = HEAPF64[index + 99];
        game.datagramQueueMax = HEAPF64[index + 100];
        game.objectResyncs = HEAPF64[index + 101];
        game.hostInputs0 = HEAPF64[index + 7];
        game.hostInputs1 = HEAPF64[index + 8];
        game.hostInputs2 = HEAPF64[index + 9];
        game.hostInputs3 = HEAPF64[index + 10];
        game.multiTickFrames = HEAPF64[index + 11];
        game.maxTicksPerFrame = HEAPF64[index + 12];
        game.tickMsMax = HEAPF64[index + 13];
        game.callbackMsMax = +HEAPF64[index + 14].toFixed(1);
        game.shaders = HEAPF64[index + 15];
        game.shaderMs = HEAPF64[index + 16];
        game.shaderMsMax = +HEAPF64[index + 17].toFixed(1);
        game.textureUploads = HEAPF64[index + 18];
        game.textureBytes = HEAPF64[index + 19];
        game.textureMs = HEAPF64[index + 20];
        game.textureMsMax = +HEAPF64[index + 21].toFixed(1);
        game.textureHashMs = HEAPF64[index + 22];
        game.textureHashMsMax = +HEAPF64[index + 23].toFixed(1);
        game.textureDrops = HEAPF64[index + 24];
        game.shaderCompiles = HEAPF64[index + 25];
        game.shaderSourceHits = HEAPF64[index + 26];
        game.pixelShaderKeys = HEAPF64[index + 27];
        game.frameGapP99Ms = +HEAPF64[index + 28].toFixed(1);
        game.framesOver = [HEAPF64[index + 29], HEAPF64[index + 30], HEAPF64[index + 31], HEAPF64[index + 32]];
        game.firstDrawGapMaxMs = +HEAPF64[index + 33].toFixed(1);
        game.overflowGapMaxMs = +HEAPF64[index + 34].toFixed(1);
        game.maxDrawsPerFrame = HEAPF64[index + 35];
        game.maxTransientUploadsPerFrame = HEAPF64[index + 36];
        game.maxTransientKilobytesPerFrame = Math.round(HEAPF64[index + 37] / 1024);
        game.transientOverflowFrames = HEAPF64[index + 38];
        game.firstDraws = HEAPF64[index + 39];
        game.firstDrawFrames = HEAPF64[index + 40];
        game.outsideFrameMaxMs = +HEAPF64[index + 41].toFixed(1);
        game.warmedPrograms = HEAPF64[index + 42];
        game.warmupMs = Math.round(HEAPF64[index + 43]);
        game.unwarmedFirstDraws = HEAPF64[index + 44];
        game.deferredDraws = HEAPF64[index + 45];
        game.deferredPrograms = HEAPF64[index + 46];
        game.programWaitMaxMs = Math.round(HEAPF64[index + 47]);
        game.rafIntervalMaxMs = +HEAPF64[index + 48].toFixed(1);
        game.rafLateMaxMs = +HEAPF64[index + 49].toFixed(1);
        var feel = function(offset) { return +HEAPF64[index + 50 + offset].toFixed(2); };
        game.feel = {
          shots: feel(0), fireP50Ms: feel(1), fireP99Ms: feel(2), fireMaxMs: feel(3),
          unansweredPresses: feel(4),
          hitConfirms: feel(5), hitConfirmP50Ms: feel(6), hitConfirmP99Ms: feel(7), hitConfirmMaxMs: feel(8),
          remoteCorrections: feel(9), remoteErrorP50: feel(10), remoteErrorP99: feel(11),
          remoteErrorMax: feel(12), remoteSnaps: feel(13),
          relayedHeldTicks: feel(14), relayedHeldRunMax: feel(15), relayedBunchedTicks: feel(16),
          unconfirmedHits: feel(17),
          /* presses while the weapon was busy (left out of fire*), and the
             fire latency split: press to the first tick taking it, that
             tick to the shot */
          busyPresses: feel(18),
          pressToTickP50Ms: feel(19), pressToTickP99Ms: feel(20), pressToTickMaxMs: feel(21),
          tickToShotP50Ms: feel(22), tickToShotP99Ms: feel(23), tickToShotMaxMs: feel(24),
        };
        /* the player's own view (render_interpolation.c): frames whose
           camera moved back along its path, further or turned further than
           the time drawn allows, or drawn earlier on the game clock; the
           worst one's context */
        var snap = function(offset) { return +HEAPF64[index + 75 + offset].toFixed(3); };
        game.snaps = {
          frames: snap(0), snaps: snap(1), backward: snap(2), clockBackward: snap(3), cuts: snap(4),
          maxStepUnits: snap(5), maxTurnDegrees: +snap(6).toFixed(1),
          worst: snap(1) ? {
            stepUnits: snap(7), allowedUnits: snap(8), turnDegrees: +snap(9).toFixed(1),
            allowedDegrees: +snap(10).toFixed(1), ticksThatFrame: snap(11), fractionBefore: snap(12),
            fraction: snap(13), frameMs: +snap(14).toFixed(1), msSinceTick: +snap(15).toFixed(1),
            firing: snap(16), crouching: snap(17), controller: snap(18), ownCorrection: snap(19), cameraCut: snap(20),
          } : null,
        };
        game.frameIntervalMeanMs = +HEAPF64[index + 96].toFixed(2);
        game.frameIntervalChangeMs = +HEAPF64[index + 97].toFixed(2);
      }
      if (typeof Module['_platform_web_profile_take_gap_maximum'] === 'function') {
        game.frameGapMaxMs = +Module['_platform_web_profile_take_gap_maximum']().toFixed(1);
        game.frameHitches = Module['_platform_web_profile_hitches']();
        if (typeof Module['_platform_web_profile_over_budget'] === 'function') {
          game.framesOverBudget = Module['_platform_web_profile_over_budget']();
          game.frames = Module['_platform_web_profile_starts']();
        }
      }
      return game;
    },

    /* One measurement window: everything since the previous window. */
    netstatsTakeWindow: async function() {
      var runtime = HaloWebTransportRuntime;
      var now = performance.now();
      var previous = runtime.netstatsWindow || { time: now, game: {} };
      var seconds = Math.max(0.001, (now - previous.time) / 1000);
      var game = runtime.netstatsGame();
      var delta = function(name) {
        return game[name] !== undefined && previous.game[name] !== undefined ?
          game[name] - previous.game[name] : null;
      };
      var peers = [];
      for (var record of runtime.peersById.values()) {
        if (!record.netstats) continue;
        var rttMs = null;
        var relayStats;
        if (record.relay) {
          var probeReliable = runtime.netstatsSamples(record.relayProbes[0]);
          var probeUnreliable = runtime.netstatsSamples(record.relayProbes[1]);
          rttMs = probeReliable.p50Ms;
          relayStats = {
            probeReliable: probeReliable,
            probeUnreliable: probeUnreliable,
            staleDatagrams: record.staleDatagrams - (record.netstatsStale || 0),
            resentFrames: record.resentFrames - (record.netstatsResent || 0),
            duplicateFrames: record.duplicateFrames - (record.netstatsDuplicates || 0),
            unacknowledgedFrames: record.resend.length,
            linked: runtime.relayLinked(record),
          };
          record.relayProbes = [[], []];
          record.netstatsStale = record.staleDatagrams;
          record.netstatsResent = record.resentFrames;
          record.netstatsDuplicates = record.duplicateFrames;
        } else {
          try {
            (await record.pc.getStats()).forEach(function(report) {
              if (report.type === 'candidate-pair' && report.nominated &&
                  report.state === 'succeeded' && report.currentRoundTripTime !== undefined) {
                rttMs = +(report.currentRoundTripTime * 1000).toFixed(1);
              }
            });
          } catch (error) { /* closed while measuring */ }
        }
        peers.push({
          peerId: record.peerId,
          rttMs: rttMs,
          droppedDatagrams: record.droppedDatagrams - (record.netstatsDropped || 0),
          reliableQueued: record.reliableQueue.length,
          unreliableQueued: record.unreliableQueue.length,
          reliable: runtime.netstatsTakeChannel(record.netstats[0], seconds),
          unreliable: runtime.netstatsTakeChannel(record.netstats[1], seconds),
          relay: relayStats,
        });
        record.netstatsDropped = record.droppedDatagrams;
      }
      var relay = runtime.relay;
      var relaySummary;
      if (relay) {
        relaySummary = {
          sockets: relay.reliable === relay.unreliable ? 1 : 2,
          edgeColo: relay.colo ? relay.colo.edge : null,
          roomColo: relay.colo ? relay.colo.room : null,
          echoReliable: runtime.netstatsSamples(relay.echo[0]),
          echoUnreliable: relay.reliable === relay.unreliable ? null : runtime.netstatsSamples(relay.echo[1]),
          maxBufferedReliable: relay.maxBuffered[0],
          maxBufferedUnreliable: relay.maxBuffered[1],
          reconnects: relay.reconnects,
          lastOutageMs: relay.lastOutageMilliseconds,
          closeCodes: relay.closeCodes,
          framesSent: relay.framesSent,
          messagesSent: relay.messagesSent,
          framesPerMessage: relay.messagesSent ? +(relay.framesSent / relay.messagesSent).toFixed(2) : null,
          kilobytesSent: Math.round(relay.bytesSent / 1024),
          multicastFrames: relay.multicastFrames,
          multicastCopies: relay.multicastCopies,
        };
        relaySummary.messagesReceived = relay.messagesReceived || 0;
        relaySummary.kilobytesReceived = Math.round((relay.bytesReceived || 0) / 1024);
        relay.messagesReceived = 0;
        relay.bytesReceived = 0;
        relay.framesSent = 0;
        relay.messagesSent = 0;
        relay.bytesSent = 0;
        relay.multicastFrames = 0;
        relay.multicastCopies = 0;
        relay.echo = [[], []];
        relay.maxBuffered = [0, 0];
        relay.closeCodes = [];
      }
      runtime.netstatsWindow = { time: now, game: game };
      var main = runtime.netstatsTakeMainThread();
      return {
        at: new Date().toISOString(),
        windowSeconds: +seconds.toFixed(2),
        visibility: document.visibilityState,
        focused: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
        transport: runtime.options.transport,
        game: {
          ticksPerSecond: delta('ticks') === null ? null : +(delta('ticks') / seconds).toFixed(1),
          ownCorrections: delta('ownCorrections'),
          ownCorrectionMaxUnits: game.ownCorrectionMaxUnits,
          rejectedPredictions: delta('rejectedPredictions'),
          frameGapMaxMs: game.frameGapMaxMs,
          frameHitches: delta('frameHitches'),
          framesPerSecond: delta('frames') === null ? null : +(delta('frames') / seconds).toFixed(1),
          framesOverBudget: delta('framesOverBudget'),
          multiTickFrames: delta('multiTickFrames'),
          maxTicksPerFrame: game.maxTicksPerFrame,
          ownAimCorrections: delta('ownAimCorrections'),
          ownAimCorrectionMaxDegrees: game.ownAimCorrectionMaxDegrees,
          ownSeatCorrections: delta('ownSeatCorrections'),
          /* (a client) how old the host's unit states are when taken, in
             ticks (one way's latency and the game clocks' offset when well;
             seconds when datagrams pile up unread), and the most datagrams
             waiting unread */
          hostStateAgeTicks: game.hostStateAgeTicks,
          hostStateAgeMaxTicks: game.hostStateAgeMaxTicks,
          datagramQueueMax: game.datagramQueueMax,
          /* asked for the host's objects again, a player's unit missing (#73) */
          objectResyncs: delta('objectResyncs'),
          /* the host: ticks that had 0, 1, 2 or 3+ client input packets */
          hostInputsPerTick: [delta('hostInputs0'), delta('hostInputs1'), delta('hostInputs2'), delta('hostInputs3')],
          /* where long frames go: ticks, the whole frame callback, new shaders
             and textures (uploads, hashing, idle drops that come back) */
          tickMsMax: game.tickMsMax,
          callbackMsMax: game.callbackMsMax,
          shaders: delta('shaders'),
          shaderCompiles: delta('shaderCompiles'),
          shaderSourceHits: delta('shaderSourceHits'),
          pixelShaderKeys: delta('pixelShaderKeys'),
          /* frame pacing: the gaps' 99th percentile, how many exceeded 16.7,
             33.3, 50 and 100 ms, and what the slowest frames had done */
          frameGapP99Ms: game.frameGapP99Ms,
          framesOver16_33_50_100Ms: game.framesOver,
          firstDraws: delta('firstDraws'),
          firstDrawFrames: game.firstDrawFrames,
          firstDrawGapMaxMs: game.firstDrawGapMaxMs,
          maxDrawsPerFrame: game.maxDrawsPerFrame,
          maxTransientUploadsPerFrame: game.maxTransientUploadsPerFrame,
          maxTransientKilobytesPerFrame: game.maxTransientKilobytesPerFrame,
          transientOverflowFrames: game.transientOverflowFrames,
          overflowGapMaxMs: game.overflowGapMaxMs,
          /* the longest time between one frame callback's end and the next
             one's start, and the render cap in force (0: the display's rate) */
          outsideFrameMaxMs: game.outsideFrameMaxMs,
          /* the shader warm-up: programs built while the map loaded, the
             last warm-up's time, and first draws it had not covered */
          warmedPrograms: delta('warmedPrograms'),
          warmupMs: game.warmupMs,
          unwarmedFirstDraws: delta('unwarmedFirstDraws'),
          /* programs compiled in the background: draws skipped meanwhile,
             the programs, and the longest wait (an effect appearing late) */
          deferredDraws: delta('deferredDraws'),
          deferredPrograms: delta('deferredPrograms'),
          programWaitMaxMs: game.programWaitMaxMs,
          /* the worker's animation frames: longest interval between two,
             longest delay from one's timestamp to the game frame */
          rafIntervalMaxMs: game.rafIntervalMaxMs,
          rafLateMaxMs: game.rafLateMaxMs,
          /* frame pacing: the mean interval between rendered frames and the
             mean change from one to the next (even pacing: near 0) */
          frameIntervalMeanMs: game.frameIntervalMeanMs,
          frameIntervalChangeMs: game.frameIntervalChangeMs,
          frameCap: typeof Module['_platform_web_frame_cap'] === 'function' ? Module['_platform_web_frame_cap']() : null,
          shaderMs: delta('shaderMs') === null ? null : +delta('shaderMs').toFixed(1),
          shaderMsMax: game.shaderMsMax,
          textureUploads: delta('textureUploads'),
          textureKilobytes: delta('textureBytes') === null ? null : Math.round(delta('textureBytes') / 1024),
          textureMs: delta('textureMs') === null ? null : +delta('textureMs').toFixed(1),
          textureMsMax: game.textureMsMax,
          textureHashMs: delta('textureHashMs') === null ? null : +delta('textureHashMs').toFixed(1),
          textureHashMsMax: game.textureHashMsMax,
          textureDrops: delta('textureDrops'),
        },
        /* shooting and the other players this window: fire button to shot
           (ms), hit reported to the host's damage back (ms), how far the
           host's word moved other players each tick (world units; snaps over
           1), and ticks run on the others' last input for want of a newer */
        feel: game.feel || null,
        snaps: game.snaps || null,
        /* the hosted page's mouse capture, totals (server/client/hosted.js) */
        pointerLock: typeof window !== 'undefined' && window.HaloHostedUI && window.HaloHostedUI.pointerLock ?
          Object.assign({}, window.HaloHostedUI.pointerLock) : null,
        peers: peers,
        relay: relaySummary,
        mainThread: main,
      };
    },

    /* The browser's main thread runs the relay's sockets, the transport's
       pump and these statistics while the game runs on a worker: its long
       tasks, how late a message posted every few milliseconds is handled (the
       event loop's lag), and the JavaScript heap. */
    netstatsStartMainThread: function() {
      var runtime = HaloWebTransportRuntime;
      var main = runtime.netstatsMain = { lags: [], longTasks: 0, longTaskMs: 0, longTaskMaxMs: 0, heapStart: null, heapMax: 0 };
      if (typeof PerformanceObserver === 'function') {
        try {
          new PerformanceObserver(function(list) {
            list.getEntries().forEach(function(entry) {
              main.longTasks++;
              main.longTaskMs += entry.duration;
              if (entry.duration > main.longTaskMaxMs) main.longTaskMaxMs = entry.duration;
            });
          }).observe({ type: 'longtask', buffered: false });
        } catch (error) { /* not supported */ }
      }
      if (typeof MessageChannel === 'function') {
        var channel = new MessageChannel();
        var sent = 0;
        var ping = function() { sent = performance.now(); channel.port2.postMessage(0); };
        channel.port1.onmessage = function() {
          if (main.lags.length < 4096) main.lags.push(performance.now() - sent);
          var timer = setTimeout(ping, 4);
          /* (Node, for the tests: the sampler alone must not keep it running) */
          if (timer && typeof timer.unref === 'function') timer.unref();
        };
        if (typeof channel.port1.unref === 'function') channel.port1.unref();
        ping();
      }
    },

    netstatsTakeMainThread: function() {
      var main = HaloWebTransportRuntime.netstatsMain;
      if (!main) return null;
      var lags = main.lags.slice().sort(function(a, b) { return a - b; });
      var heap = typeof performance !== 'undefined' && performance.memory ? performance.memory.usedJSHeapSize : null;
      var result = {
        lagP99Ms: lags.length ? +lags[Math.min(lags.length - 1, Math.floor(lags.length * 0.99))].toFixed(1) : null,
        lagMaxMs: lags.length ? +lags[lags.length - 1].toFixed(1) : null,
        lagSamples: lags.length,
        longTasks: main.longTasks,
        longTaskMs: Math.round(main.longTaskMs),
        longTaskMaxMs: Math.round(main.longTaskMaxMs),
        heapMegabytes: heap === null ? null : +(heap / 1048576).toFixed(1),
        heapChangeMegabytes: heap === null || main.heapStart === null ? null : +((heap - main.heapStart) / 1048576).toFixed(1),
      };
      main.lags = [];
      main.longTasks = 0;
      main.longTaskMs = 0;
      main.longTaskMaxMs = 0;
      main.heapStart = heap;
      return result;
    },

    netstatsSamples: function(samples) {
      var sorted = samples.slice().sort(function(a, b) { return a - b; });
      var at = function(fraction) {
        return sorted.length ?
          +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))].toFixed(1) : null;
      };
      return {
        count: sorted.length,
        p50Ms: at(0.5),
        p99Ms: at(0.99),
        maxMs: sorted.length ? +sorted[sorted.length - 1].toFixed(1) : null,
      };
    },

    startNetstatsLog: function() {
      var runtime = HaloWebTransportRuntime;
      runtime.netstatsStartMainThread();
      runtime.netstatsTakeWindow();
      setInterval(function() {
        runtime.netstatsTakeWindow().then(function(stats) {
          runtime.netstatsHistory.push(stats);
          if (runtime.netstatsHistory.length > runtime.NETSTATS_HISTORY_WINDOWS) {
            runtime.netstatsHistory.shift();
          }
          /* (uploaded windows stay out of the console: several kilobytes
             every five seconds, which an embedding page may forward) */
          if (runtime.netstatsUpload) runtime.netstatsSend(stats);
          else console.info('[netstats] ' + JSON.stringify(stats));
        });
      }, runtime.NETSTATS_LOG_MILLISECONDS);
    },

    /* With the server's halo-netstats-upload meta (an opt-in of the server's
       operator), each window also goes to the server's log. */
    netstatsSend: function(stats) {
      try {
        fetch('v1/netstats', {
          method: 'POST',
          credentials: 'same-origin',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(stats),
        }).catch(function() {});
      } catch (error) { /* best effort */ }
    },

    deliverOne: function(record, reliable) {
      var runtime = HaloWebTransportRuntime;
      var queue = reliable ? record.reliableQueue : record.unreliableQueue;
      if (!queue.length || !runtime.channelsReady(record)) return 1;
      var bytes = queue[0];
      var ingress = runtime.moduleFunction('web_net_remote_ingress_buffer')();
      var capacity = runtime.moduleFunction('web_net_remote_ingress_capacity')();
      if (bytes.byteLength > capacity) return -1;
      HEAPU8.set(bytes, ingress);
      var result = runtime.moduleFunction('web_net_remote_receive')(
        record.address, bytes.byteLength);
      if (result > 0) {
        queue.shift();
        if (reliable) record.reliableQueuedBytes -= bytes.byteLength;
        else record.unreliableQueuedBytes -= bytes.byteLength;
      }
      return result;
    },

    pump: function() {
      var runtime = HaloWebTransportRuntime;
      if (runtime.pumping) return;
      runtime.pumping = true;
      var retry = false;
      var queuedBefore = 0;
      var queuedAfter = 0;
      try {
        runtime.peersById.forEach(function(record) {
          if (record.removed) return;
          queuedBefore += record.reliableQueue.length + record.unreliableQueue.length;
          if (record.needsStateSync) runtime.syncPeerState(record);
          var reliableResult = runtime.deliverOne(record, true);
          if (reliableResult < 0) {
            runtime.failPeer(record, new Error('Malformed reliable transport frame'));
            return;
          }
          if (reliableResult === 0) retry = true;
          /* Bound work per task so packet bursts do not monopolize the UI. */
          for (var index = 0; index < 16 && record.unreliableQueue.length; index++) {
            var unreliableResult = runtime.deliverOne(record, false);
            if (unreliableResult < 0) {
              runtime.failPeer(record, new Error('Malformed unreliable transport frame'));
              return;
            }
            if (unreliableResult === 0) {
              retry = true;
              break;
            }
          }
          queuedAfter += record.reliableQueue.length + record.unreliableQueue.length;
          if (record.needsStateSync ||
              (runtime.channelsReady(record) &&
               (record.reliableQueue.length || record.unreliableQueue.length))) retry = true;
        });
      } finally {
        runtime.pumping = false;
      }
      if (!retry) return;
      if (queuedAfter < queuedBefore) {
        runtime.idlePumpRetries = 0;
        runtime.schedulePump();
      } else {
        runtime.scheduleIdlePumpRetry();
      }
    },

    makeOffer: async function(record, iceRestart) {
      if (record.removed || record.makingOffer) return;
      record.makingOffer = true;
      try {
        if (iceRestart) {
          record.pc.restartIce();
        }
        await record.pc.setLocalDescription();
        if (record.removed) return;
        HaloWebTransportRuntime.emitSignal(record, {
          description: record.pc.localDescription.toJSON(),
        });
      } catch (error) {
        HaloWebTransportRuntime.failPeer(record, error);
      } finally {
        record.makingOffer = false;
      }
    },

    failPeer: function(record, error) {
      if (!record || record.removed) return;
      HaloWebTransportRuntime.reportError(record, error);
      HaloWebTransportRuntime.emitState(record, 'failed', error.message || String(error));
      HaloWebTransportRuntime.removePeer(record.peerId);
    },

    addPeer: async function(options) {
      var runtime = HaloWebTransportRuntime;
      if (!options || typeof options.peerId !== 'string' || !options.peerId ||
          options.peerId.length > 128) {
        throw new TypeError('peerId must be a non-empty string of at most 128 characters');
      }
      if (runtime.peersById.has(options.peerId)) {
        throw new Error('Peer already exists: ' + options.peerId);
      }
      var identifier = runtime.identifierBytes(options.remoteIdentifier);
      if (runtime.identifierText(identifier) === runtime.localIdentifier()) {
        throw new Error('Cannot connect this browser to itself');
      }
      var address = await runtime.registerPeer(identifier);
      if (!address) throw new Error('No virtual peer addresses are available');
      if (runtime.peersByAddress.has(address)) {
        throw new Error('A virtual peer address is already in use');
      }
      if (runtime.options.transport === 'relay') {
        return runtime.addRelayPeer(options, identifier, address);
      }
      var configuration = {
        iceServers: options.iceServers || runtime.options.iceServers || [],
        bundlePolicy: 'max-bundle',
      };
      var pc = new RTCPeerConnection(configuration);
      var record = {
        peerId: options.peerId,
        identifier: runtime.identifierText(identifier),
        address: address,
        addressText: runtime.addressText(address),
        pc: pc,
        polite: options.polite !== undefined ? !!options.polite : !options.initiator,
        makingOffer: false,
        ignoreOffer: false,
        settingRemoteAnswer: false,
        pendingCandidates: [],
        remoteCandidateCount: 0,
        reliable: null,
        unreliable: null,
        reliableQueue: [],
        unreliableQueue: [],
        reliableQueuedBytes: 0,
        unreliableQueuedBytes: 0,
        droppedDatagrams: 0,
        netstats: runtime.netstatsEnabled ?
          [runtime.netstatsChannel(), runtime.netstatsChannel()] : null,
        needsStateSync: true,
        lastPublicState: null,
        removed: false,
      };
      runtime.peersById.set(record.peerId, record);
      runtime.peersByAddress.set(record.address, record);
      pc.onicecandidate = function(event) {
        if (event.candidate) {
          runtime.emitSignal(record, { candidate: event.candidate.toJSON() });
        }
      };
      pc.onicecandidateerror = function(event) {
        runtime.reportError(record, new Error('ICE candidate failed: ' +
          (event.errorText || event.errorCode || 'unknown error')));
      };
      pc.onconnectionstatechange = function() {
        var state = pc.connectionState;
        if (state === 'failed') {
          runtime.failPeer(record, new Error('WebRTC connection failed'));
        } else if (state === 'closed') {
          runtime.emitState(record, 'disconnected');
        } else if (state === 'connecting' || state === 'new') {
          runtime.emitState(record, 'connecting');
        }
      };
      pc.ondatachannel = function(event) {
        if (event.channel.label === runtime.RELIABLE_LABEL) {
          runtime.configureChannel(record, event.channel, true);
        } else if (event.channel.label === runtime.UNRELIABLE_LABEL) {
          runtime.configureChannel(record, event.channel, false);
        } else {
          event.channel.close();
        }
      };
      pc.onnegotiationneeded = function() { runtime.makeOffer(record, false); };
      if (options.initiator) {
        runtime.configureChannel(record, pc.createDataChannel(runtime.RELIABLE_LABEL, {
          ordered: true,
        }), true);
        runtime.configureChannel(record, pc.createDataChannel(runtime.UNRELIABLE_LABEL, {
          ordered: false,
          maxRetransmits: 0,
        }), false);
      }
      runtime.emitState(record, 'connecting');
      return {
        peerId: record.peerId,
        address: record.addressText,
        remoteIdentifier: record.identifier,
      };
    },

    handleSignal: async function(peerId, signal) {
      var runtime = HaloWebTransportRuntime;
      var record = runtime.peersById.get(peerId);
      if (!record || record.removed) throw new Error('Unknown peer: ' + peerId);
      if (record.relay) throw new Error('Relay peers take no signals');
      if (!signal || (signal.description === undefined && signal.candidate === undefined)) {
        throw new TypeError('Signal must contain a description or candidate');
      }
      if (signal.description) {
        var description = signal.description;
        if (description.type !== 'offer' && description.type !== 'answer') {
          throw new TypeError('Unsupported session description type');
        }
        var readyForOffer = !record.makingOffer &&
          (record.pc.signalingState === 'stable' || record.settingRemoteAnswer);
        var offerCollision = description.type === 'offer' && !readyForOffer;
        record.ignoreOffer = !record.polite && offerCollision;
        if (record.ignoreOffer) return;
        record.settingRemoteAnswer = description.type === 'answer';
        try {
          if (offerCollision) {
            await record.pc.setLocalDescription({ type: 'rollback' });
          }
          await record.pc.setRemoteDescription(description);
          record.settingRemoteAnswer = false;
          while (record.pendingCandidates.length) {
            await record.pc.addIceCandidate(record.pendingCandidates.shift());
          }
          if (description.type === 'offer') {
            await record.pc.setLocalDescription();
            runtime.emitSignal(record, {
              description: record.pc.localDescription.toJSON(),
            });
          }
        } catch (error) {
          record.settingRemoteAnswer = false;
          runtime.failPeer(record, error);
          throw error;
        }
      }
      if (signal.candidate) {
        try {
          record.remoteCandidateCount++;
          if (record.remoteCandidateCount > runtime.REMOTE_CANDIDATE_LIMIT) {
            throw new Error('Peer sent too many ICE candidates');
          }
          if (record.pc.remoteDescription) {
            await record.pc.addIceCandidate(signal.candidate);
          } else {
            record.pendingCandidates.push(signal.candidate);
          }
        } catch (error) {
          if (!record.ignoreOffer) throw error;
        }
      }
    },

    restartIce: async function(peerId) {
      var record = HaloWebTransportRuntime.peersById.get(peerId);
      if (!record || record.removed) throw new Error('Unknown peer: ' + peerId);
      if (record.relay) return;
      await HaloWebTransportRuntime.makeOffer(record, true);
    },

    removePeer: function(peerId) {
      var runtime = HaloWebTransportRuntime;
      var record = runtime.peersById.get(peerId);
      if (!record || record.removed) return false;
      record.removed = true;
      if (record.reliable) record.reliable.close();
      if (record.unreliable) record.unreliable.close();
      if (record.pc) record.pc.close();
      if (record.relay && runtime.relayPeers.get(record.identifier) === record) {
        runtime.relayPeers.delete(record.identifier);
      }
      runtime.peersById.delete(peerId);
      if (runtime.peersByAddress.get(record.address) === record) {
        runtime.peersByAddress.delete(record.address);
        runtime.removePeerFromWasm(record.address);
      }
      runtime.emitState(record, 'disconnected');
      return true;
    },

    send: function(address, reliable, pointer, length) {
      var runtime = HaloWebTransportRuntime;
      var record = runtime.peersByAddress.get(runtime.normalizeAddress(address));
      if (!record || record.removed || length < 12 || length > 16396) return 0;
      if (record.relay) return runtime.relaySend(record, reliable, pointer, length);
      var channel = reliable ? record.reliable : record.unreliable;
      var highWater = reliable ? runtime.RELIABLE_HIGH_WATER :
        runtime.UNRELIABLE_HIGH_WATER;
      if (!runtime.channelWriteable(channel, highWater)) {
        record.needsStateSync = true;
        runtime.schedulePump();
        return 0;
      }
      try {
        var frame = HEAPU8.slice(pointer, pointer + length);
        channel.send(frame);
        if (channel.bufferedAmount > highWater) {
          record.needsStateSync = true;
          runtime.schedulePump();
        }
        return 1;
      } catch (error) {
        runtime.reportError(record, error);
        record.needsStateSync = true;
        runtime.schedulePump();
        return 0;
      }
    },

    /* WebSocket relay (configure({ transport: 'relay' })).

       Every peer shares this browser's socket(s) to the room's relay. Each
       binary message is [channel][6-byte peer identifier][payload]; the relay
       replaces the identifier with the sender's.

       Reliable frames carry [u32 sequence][u32 acknowledgement][Halo frame].
       The sender keeps each one until the peer acknowledges it and replays
       the unacknowledged ones whenever either side reconnects; the receiver
       delivers each sequence number once and in order.  Halo's reliable
       streams therefore survive a dropped socket.  While a socket reconnects
       or the peer is away, the game keeps the peer; only after
       RELAY_GRACE_MILLISECONDS without a path does the peer fail.

       TCP never drops, so a datagram that would wait behind a backed-up
       socket, or has no path at all, is dropped here, as a network would. */
    RELAY_CHANNEL: Object.freeze({
      RELIABLE: 0, UNRELIABLE: 1, PING_RELIABLE: 2, PONG_RELIABLE: 3,
      PING_UNRELIABLE: 4, PONG_UNRELIABLE: 5, ECHO: 6, ACK: 7,
    }),
    RELAY_HEADER_BYTES: 7,
    RELAY_SEQUENCE_BYTES: 8,
    /* relay protocol 2 (server/src/protocol.ts): the host may send a frame
       once for many guests */
    RELAY_PROTOCOL: 2,
    RELAY_MULTICAST: 8,
    /* (server/src/protocol.ts MAXIMUM_SLOTS: one per machine in a room) */
    RELAY_MAXIMUM_SLOTS: 72,
    RELAY_MULTICAST_RELIABLE_ENTRY_BYTES: 14,
    RELAY_MULTICAST_UNRELIABLE_ENTRY_BYTES: 2,
    /* (a reliable frame's loopback frame) the per-connection word, which the
       relay writes for each recipient */
    RELAY_MULTICAST_WORD_OFFSET: 4,
    RELAY_DATAGRAM_DROP_BYTES: 4096,
    RELAY_PROBE_MILLISECONDS: 250,
    RELAY_RESEND_LIMIT: 4 * 1024 * 1024,
    RELAY_ACK_EVERY: 8,
    RELAY_ACK_MILLISECONDS: 50,
    RELAY_GRACE_MILLISECONDS: 20000,
    RELAY_RECONNECT_MILLISECONDS: [250, 500, 1000, 2000, 4000],
    RELAY_BATCH_MARKER: 0x80,
    RELAY_BATCH_LIMIT: 60 * 1024,
    RELAY_FLUSH_MILLISECONDS: 4,
    /* frames that can wait for the next game frame's message (acknowledgements,
       probes): the longest they wait when the game is not ticking */
    RELAY_LAZY_FLUSH_MILLISECONDS: 40,
    /* (web_loopback_net.c) a frame of datagrams for the same ports */
    LOOPBACK_DATAGRAM: 1,
    LOOPBACK_DATAGRAM_BUNDLE: 5,
    LOOPBACK_HEADER_BYTES: 12,
    LOOPBACK_BUNDLE_LIMIT: 16 * 1024,
    relayPeers: new Map(),
    relay: null,

    relayKey: function(options) {
      return [options.url, options.roomId, options.role, options.sockets].join('|');
    },

    /* A frame can reach this peer right now. */
    relayLinked: function(record) {
      var relay = HaloWebTransportRuntime.relay;
      return !!relay && !relay.failed && relay.ready &&
        relay.reliable.readyState === 1 && relay.unreliable.readyState === 1 &&
        relay.present.has(record.identifier);
    },

    /* What the game sees: connected from the first link until the grace
       period for an outage runs out. */
    relayReady: function(record) {
      return record.relayEverLinked ? !record.removed :
        HaloWebTransportRuntime.relayLinked(record);
    },

    openRelay: function() {
      var runtime = HaloWebTransportRuntime;
      var options = runtime.options.relay;
      if (!options || !options.url || !options.roomId || !options.role) {
        throw new Error('The WebSocket relay is not configured');
      }
      var key = runtime.relayKey(options);
      if (runtime.relay && runtime.relay.key === key && !runtime.relay.failed) return;
      runtime.closeRelay();
      var relay = {
        key: key,
        options: options,
        generation: 0,
        ready: false,
        present: new Set(),
        failed: false,
        reliable: null,
        unreliable: null,
        reconnectAttempt: 0,
        reconnectTimer: 0,
        watchTimer: 0,
        timers: [],
        everReady: false,
        reconnects: 0,
        outageStart: 0,
        lastOutageMilliseconds: null,
        closeCodes: [],
        echo: [[], []],
        maxBuffered: [0, 0],
        /* Frames waiting for the end of the game frame, per socket. */
        batching: options.batch !== false,
        outbox: new Map(),
        flushTimer: 0,
        framesSent: 0,
        messagesSent: 0,
        bytesSent: 0,
        /* (protocol 2) frames sent once for several guests, and the copies the
           relay made of them */
        multicastFrames: 0,
        multicastCopies: 0,
        /* (protocol 2) counterparts' relay slots: identifier -> {slot, generation} */
        slots: new Map(),
        names: new Map(),
        discovering: new Set(),
      };
      runtime.relay = relay;
      runtime.relayConnect(relay);
      relay.timers.push(setInterval(runtime.relayFlushAcks, runtime.RELAY_ACK_MILLISECONDS));
      relay.timers.push(setInterval(runtime.relayCheckGrace, 1000));
      if (runtime.netstatsEnabled) {
        relay.timers.push(setInterval(runtime.relayProbe, runtime.RELAY_PROBE_MILLISECONDS));
      }
      runtime.relaySetBatching(relay.batching);
    },

    relaySetBatching: function(enabled) {
      var setter = typeof Module !== 'undefined' && Module['_web_net_remote_set_batching'];
      if (typeof setter === 'function') setter(enabled ? 1 : 0);
    },

    relayConnect: function(relay) {
      var runtime = HaloWebTransportRuntime;
      var generation = ++relay.generation;
      var base = new URL(relay.options.url);
      if (base.protocol === 'http:') base.protocol = 'ws:';
      if (base.protocol === 'https:') base.protocol = 'wss:';
      var identifier = runtime.localIdentifier();
      var open = function(kind) {
        var url = new URL('v1/rooms/' + encodeURIComponent(relay.options.roomId) + '/ws',
          base.href.replace(/\/?$/, '/'));
        url.search = new URLSearchParams({ role: relay.options.role, ch: kind }).toString();
        var socket = new WebSocket(url.href);
        var current = function() { return runtime.relay === relay && relay.generation === generation; };
        socket.binaryType = 'arraybuffer';
        socket.onopen = function() {
          if (!current()) return;
          /* Browsers cannot set WebSocket headers: the session token is the
             first message, and the relay answers it with "ready". */
          var auth = relay.options.auth;
          if (auth) {
            var hello = { type: 'auth', token: auth.getToken(), id: identifier, build: auth.build,
              protocol: runtime.RELAY_PROTOCOL };
            /* (a guest that watches the match without a player, #52) */
            if (typeof auth.spectator === 'function' && auth.spectator()) hello.spectator = true;
            socket.send(JSON.stringify(hello));
          }
          runtime.relaySyncAll();
        };
        socket.onmessage = function(event) { if (current()) runtime.relayMessage(relay, socket, event.data); };
        socket.onclose = function(event) { if (current()) runtime.relayLost(relay, event.code); };
        return socket;
      };
      relay.ready = false;
      relay.present = new Set();
      if (relay.options.sockets === 2) {
        relay.reliable = open('r');
        relay.unreliable = open('u');
      } else {
        relay.reliable = relay.unreliable = open('both');
      }
    },

    /* (the host) whether its game is past the lobby, and whether a player can
       join its match as it runs, for the room's status: others join the
       match, or wait for it to end rather than fail to join. Sent again on
       every reconnect. */
    relaySendPhase: function(relay) {
      if (!relay || !relay.ready || relay.options.role !== 'host' || relay.inMatch === undefined) return;
      try {
        relay.reliable.send(JSON.stringify(Object.assign({}, relay.phaseDetails || {},
          { type: 'phase', inMatch: relay.inMatch, joinable: !!relay.joinable })));
      } catch (error) {
        /* closing: the next "ready" sends it */
      }
    },

    relayCloseSockets: function(relay, code) {
      [relay.reliable, relay.unreliable].forEach(function(socket) {
        if (!socket) return;
        try { socket.close(code || 1000); } catch (error) { /* already closed */ }
      });
    },

    /* A socket closed while the relay was wanted: reconnect both. */
    relayLost: function(relay, code) {
      var runtime = HaloWebTransportRuntime;
      relay.generation++;
      relay.ready = false;
      relay.present = new Set();
      /* Reliable frames in it are still in the replay buffer. */
      relay.outbox.clear();
      relay.closeCodes.push(code);
      if (!relay.outageStart) relay.outageStart = performance.now();
      runtime.relayCloseSockets(relay, 1000);
      runtime.relaySyncAll();
      var delays = runtime.RELAY_RECONNECT_MILLISECONDS;
      var delay = delays[Math.min(relay.reconnectAttempt++, delays.length - 1)];
      clearTimeout(relay.reconnectTimer);
      relay.reconnectTimer = setTimeout(function() {
        relay.reconnectTimer = 0;
        if (runtime.relay === relay && !relay.failed) runtime.relayConnect(relay);
      }, delay);
    },

    closeRelay: function() {
      var runtime = HaloWebTransportRuntime;
      var relay = runtime.relay;
      if (!relay) return;
      runtime.relay = null;
      relay.failed = true;
      relay.generation++;
      relay.timers.forEach(clearInterval);
      clearTimeout(relay.reconnectTimer);
      clearTimeout(relay.watchTimer);
      clearTimeout(relay.flushTimer);
      relay.outbox.clear();
      runtime.relaySetBatching(false);
      runtime.relayCloseSockets(relay, 1000);
    },

    /* Queues a frame for the socket; relayFlush sends each socket's queue as
       one message at the end of the game frame (web_net_end_frame), or after
       RELAY_FLUSH_MILLISECONDS if the game is not ticking (a lazy frame, after
       RELAY_LAZY_FLUSH_MILLISECONDS: it rides with the next game frame's). */
    relayQueue: function(socket, frame, lazy) {
      var runtime = HaloWebTransportRuntime;
      var relay = runtime.relay;
      if (!relay || socket.readyState !== 1) return;
      if (!relay.batching) {
        runtime.relaySendMessage(relay, socket, [frame]);
        return;
      }
      var box = relay.outbox.get(socket);
      if (!box) {
        box = { frames: [], bytes: 1 };
        relay.outbox.set(socket, box);
      }
      if (box.bytes + 2 + frame.byteLength > runtime.RELAY_BATCH_LIMIT) {
        runtime.relaySendMessage(relay, socket, box.frames);
        box.frames = [];
        box.bytes = 1;
      }
      box.frames.push(frame);
      box.bytes += 2 + frame.byteLength;
      runtime.relayArmFlush(relay, lazy);
    },

    relayArmFlush: function(relay, lazy) {
      var runtime = HaloWebTransportRuntime;
      if (relay.flushTimer && (lazy || !relay.flushLazy)) return;
      clearTimeout(relay.flushTimer);
      relay.flushLazy = !!lazy;
      relay.flushTimer = setTimeout(runtime.relayFlush,
        lazy ? runtime.RELAY_LAZY_FLUSH_MILLISECONDS : runtime.RELAY_FLUSH_MILLISECONDS);
    },

    relayFlush: function() {
      var runtime = HaloWebTransportRuntime;
      var relay = runtime.relay;
      if (!relay) return;
      runtime.relayFlushDatagrams(relay);
      clearTimeout(relay.flushTimer);
      relay.flushTimer = 0;
      relay.outbox.forEach(function(box, socket) {
        if (box.frames.length) runtime.relaySendMessage(relay, socket, box.frames);
      });
      relay.outbox.clear();
    },

    /* A game frame's datagrams for a peer, as few relay frames as they make:
       datagrams for the same ports in one bundle (web_loopback_net.c), each
       with its length. A single one goes as it is. (Protocol 2, the host)
       datagrams the same for several guests first go once for all of them
       (relayMulticastDatagrams). */
    relayFlushDatagrams: function(relay) {
      var runtime = HaloWebTransportRuntime;
      var pending = [];
      runtime.relayPeers.forEach(function(record) {
        var datagrams = record.pendingDatagrams;
        if (!datagrams || !datagrams.length) return;
        record.pendingDatagrams = [];
        if (!runtime.relayLinked(record) || !relay.unreliable) {
          record.staleDatagrams += datagrams.length;
          return;
        }
        pending.push({ record: record, datagrams: datagrams });
      });
      runtime.relayMulticastDatagrams(relay, pending);
      pending.forEach(function(entry) {
        runtime.relayBundles(entry.datagrams, function(halo) {
          runtime.relayTransmit(entry.record, relay.unreliable, runtime.relayDatagramFrame(entry.record, halo));
        });
      });
    },

    /* Loopback datagrams as bundles (web_loopback_net.c): emit(halo) for each. */
    relayBundles: function(datagrams, emit) {
      var runtime = HaloWebTransportRuntime;
      var group = [];
      var groupBytes = 0;
      var sendGroup = function() {
        if (!group.length) return;
        var halo = group[0];
        if (group.length > 1) {
          halo = new Uint8Array(runtime.LOOPBACK_HEADER_BYTES + groupBytes);
          halo.set(group[0].subarray(0, runtime.LOOPBACK_HEADER_BYTES));
          halo[2] = runtime.LOOPBACK_DATAGRAM_BUNDLE;
          var offset = runtime.LOOPBACK_HEADER_BYTES;
          group.forEach(function(datagram) {
            var length = datagram.byteLength - runtime.LOOPBACK_HEADER_BYTES;
            halo[offset] = length >> 8;
            halo[offset + 1] = length & 255;
            halo.set(datagram.subarray(runtime.LOOPBACK_HEADER_BYTES), offset + 2);
            offset += 2 + length;
          });
        }
        emit(halo);
        group = [];
        groupBytes = 0;
      };
      datagrams.forEach(function(datagram) {
        var bundled = datagram.byteLength > runtime.LOOPBACK_HEADER_BYTES &&
          datagram[2] === runtime.LOOPBACK_DATAGRAM;
        var length = datagram.byteLength - runtime.LOOPBACK_HEADER_BYTES;
        var sameHeader = group.length && bundled && group[0][2] === runtime.LOOPBACK_DATAGRAM &&
          group[0].subarray(0, runtime.LOOPBACK_HEADER_BYTES).every(function(value, index) {
            return value === datagram[index];
          });
        if (!sameHeader || groupBytes + 2 + length > runtime.LOOPBACK_BUNDLE_LIMIT) sendGroup();
        group.push(datagram);
        groupBytes += 2 + length;
        if (!bundled) sendGroup();
      });
      sendGroup();
    },

    /* (protocol 2, the host) a game frame's datagrams that are the same for
       several guests, taken out of their pending lists and sent once for each
       set of guests that has them, bundled as relayBundles would. */
    relayMulticastDatagrams: function(relay, pending) {
      var runtime = HaloWebTransportRuntime;
      if (relay.options.role !== 'host' || !relay.slots.size || pending.length < 2) return;
      var groups = [];
      pending.forEach(function(entry) {
        if (!relay.slots.has(entry.record.identifier)) return;
        entry.datagrams.forEach(function(datagram) {
          var group = null;
          for (var index = 0; index < groups.length && !group; index++) {
            var candidate = groups[index];
            if (candidate.entries.indexOf(entry) < 0 && candidate.entries.length < runtime.RELAY_MAXIMUM_SLOTS &&
                runtime.relaySameContent(candidate.datagram, datagram, 0, -1)) group = candidate;
          }
          if (group) group.entries.push(entry);
          else groups.push({ datagram: datagram, entries: [entry] });
        });
      });
      var sets = new Map();
      groups.forEach(function(group) {
        if (group.entries.length < 2) return;
        var key = group.entries.map(function(entry) { return entry.record.identifier; }).sort().join(',');
        var set = sets.get(key);
        if (!set) sets.set(key, set = { entries: group.entries, datagrams: [] });
        set.datagrams.push(group.datagram);
        group.entries.forEach(function(entry) {
          for (var index = 0; index < entry.datagrams.length; index++) {
            if (runtime.relaySameContent(entry.datagrams[index], group.datagram, 0, -1)) {
              entry.datagrams.splice(index, 1);
              break;
            }
          }
        });
      });
      sets.forEach(function(set) {
        runtime.relayBundles(set.datagrams, function(halo) {
          var frame = new Uint8Array(runtime.RELAY_HEADER_BYTES + halo.byteLength);
          frame[0] = runtime.RELAY_CHANNEL.UNRELIABLE;
          frame.set(halo, runtime.RELAY_HEADER_BYTES);
          runtime.relayQueue(relay.unreliable, runtime.relayMulticastFrame(relay, false,
            set.entries.map(function(entry) {
              return { frame: frame, slot: relay.slots.get(entry.record.identifier) };
            })));
        });
      });
    },

    relayDatagramFrame: function(record, halo) {
      var runtime = HaloWebTransportRuntime;
      var frame = new Uint8Array(runtime.RELAY_HEADER_BYTES + halo.byteLength);
      frame[0] = runtime.RELAY_CHANNEL.UNRELIABLE;
      frame.set(record.identifierBytes, 1);
      frame.set(halo, runtime.RELAY_HEADER_BYTES);
      return frame;
    },

    /* (protocol 2) a counterpart's slot, as the relay announced it */
    relaySetSlot: function(relay, id, entry) {
      var valid = Array.isArray(entry) && entry.length === 2 && entry.every(function(value) {
        return Number.isInteger(value) && value >= 0 && value <= 255;
      }) && entry[0] < HaloWebTransportRuntime.RELAY_MAXIMUM_SLOTS;
      if (valid) relay.slots.set(id, { slot: entry[0], generation: entry[1] });
      else relay.slots.delete(id);
    },

    /* Whether two frames carry the same bytes from offset on, but for the
       four at offset + skip (skip < 0: none). */
    relaySameContent: function(a, b, offset, skip) {
      if (a.byteLength !== b.byteLength) return false;
      for (var index = offset; index < a.byteLength; index++) {
        if (skip >= 0 && index >= offset + skip && index < offset + skip + 4) continue;
        if (a[index] !== b[index]) return false;
      }
      return true;
    },

    /* (protocol 2, the host) a message's frames with those the relay can fan
       out sent once (server/src/protocol.ts): a run of reliable frames side by
       side for different guests, the same but for each one's sequence,
       acknowledgement and loopback connection word (the engine writing one
       message to every machine), and datagrams the same for several guests.
       A guest's reliable frames keep their order: only neighbours merge. */
    relayMulticast: function(relay, frames) {
      var runtime = HaloWebTransportRuntime;
      var channels = runtime.RELAY_CHANNEL;
      if (relay.options.role !== 'host' || !relay.slots.size || frames.length < 2) return frames;
      var header = runtime.RELAY_HEADER_BYTES;
      var reliablePrefix = header + runtime.RELAY_SEQUENCE_BYTES;
      var slotOf = function(frame) {
        return relay.slots.get(runtime.identifierText(frame.subarray(1, header))) || null;
      };
      var out = [];
      var datagrams = [];
      for (var index = 0; index < frames.length;) {
        var frame = frames[index];
        var slot = frame[0] === channels.RELIABLE || frame[0] === channels.UNRELIABLE ? slotOf(frame) : null;
        if (slot && frame[0] === channels.UNRELIABLE && frame.byteLength > header) {
          var group = null;
          for (var at = 0; at < datagrams.length && !group; at++) {
            var candidate = datagrams[at];
            if (candidate.length < runtime.RELAY_MAXIMUM_SLOTS &&
                !candidate.some(function(entry) { return entry.slot.slot === slot.slot; }) &&
                runtime.relaySameContent(candidate[0].frame, frame, header, -1)) group = candidate;
          }
          if (!group) {
            group = [];
            datagrams.push(group);
            out.push(group);
          }
          group.push({ frame: frame, slot: slot });
          index++;
          continue;
        }
        if (slot && frame[0] === channels.RELIABLE && frame.byteLength >= reliablePrefix + 8) {
          var run = [{ frame: frame, slot: slot }];
          var next = index + 1;
          while (next < frames.length && run.length < runtime.RELAY_MAXIMUM_SLOTS) {
            var following = frames[next];
            var followingSlot = following[0] === channels.RELIABLE ? slotOf(following) : null;
            if (!followingSlot || run.some(function(entry) { return entry.slot.slot === followingSlot.slot; }) ||
                !runtime.relaySameContent(frame, following, reliablePrefix, runtime.RELAY_MULTICAST_WORD_OFFSET)) break;
            run.push({ frame: following, slot: followingSlot });
            next++;
          }
          if (run.length > 1) {
            out.push(runtime.relayMulticastFrame(relay, true, run));
            index = next;
            continue;
          }
        }
        out.push(frame);
        index++;
      }
      return out.map(function(entry) {
        if (!Array.isArray(entry)) return entry;
        return entry.length > 1 ? runtime.relayMulticastFrame(relay, false, entry) : entry[0].frame;
      });
    },

    relayMulticastFrame: function(relay, reliable, entries) {
      var runtime = HaloWebTransportRuntime;
      var prefix = runtime.RELAY_HEADER_BYTES + (reliable ? runtime.RELAY_SEQUENCE_BYTES : 0);
      var entryBytes = reliable ? runtime.RELAY_MULTICAST_RELIABLE_ENTRY_BYTES :
        runtime.RELAY_MULTICAST_UNRELIABLE_ENTRY_BYTES;
      var payload = entries[0].frame.subarray(prefix);
      var frame = new Uint8Array(3 + entries.length * entryBytes + payload.byteLength);
      var view = new DataView(frame.buffer);
      frame[0] = runtime.RELAY_MULTICAST;
      frame[1] = reliable ? runtime.RELAY_CHANNEL.RELIABLE : runtime.RELAY_CHANNEL.UNRELIABLE;
      frame[2] = entries.length;
      entries.forEach(function(entry, index) {
        var offset = 3 + index * entryBytes;
        frame[offset] = entry.slot.slot;
        frame[offset + 1] = entry.slot.generation;
        if (reliable) {
          var source = new DataView(entry.frame.buffer, entry.frame.byteOffset, entry.frame.byteLength);
          view.setUint32(offset + 2, source.getUint32(runtime.RELAY_HEADER_BYTES));
          view.setUint32(offset + 6, source.getUint32(runtime.RELAY_HEADER_BYTES + 4));
          view.setUint32(offset + 10, source.getUint32(prefix + runtime.RELAY_MULTICAST_WORD_OFFSET));
        }
      });
      frame.set(payload, 3 + entries.length * entryBytes);
      relay.multicastFrames++;
      relay.multicastCopies += entries.length;
      return frame;
    },

    relaySendMessage: function(relay, socket, frames) {
      if (socket.readyState !== 1) return;
      frames = HaloWebTransportRuntime.relayMulticast(relay, frames);
      /* (a probe that waited for this message: timed from now) */
      var channels = HaloWebTransportRuntime.RELAY_CHANNEL;
      frames.forEach(function(frame) {
        if ((frame[0] === channels.PING_RELIABLE || frame[0] === channels.PING_UNRELIABLE ||
             frame[0] === channels.ECHO) && frame.byteLength >= HaloWebTransportRuntime.RELAY_HEADER_BYTES + 8) {
          new DataView(frame.buffer, frame.byteOffset).setFloat64(HaloWebTransportRuntime.RELAY_HEADER_BYTES,
            performance.now(), true);
        }
      });
      var message = frames[0];
      if (frames.length > 1) {
        var size = 1;
        frames.forEach(function(frame) { size += 2 + frame.byteLength; });
        message = new Uint8Array(size);
        message[0] = HaloWebTransportRuntime.RELAY_BATCH_MARKER;
        var offset = 1;
        frames.forEach(function(frame) {
          message[offset] = frame.byteLength >> 8;
          message[offset + 1] = frame.byteLength & 255;
          message.set(frame, offset + 2);
          offset += 2 + frame.byteLength;
        });
      }
      try {
        socket.send(message);
      } catch (error) {
        /* Closing: its close event starts the reconnect and replay. */
        return;
      }
      relay.framesSent += frames.length;
      relay.messagesSent++;
      relay.bytesSent += message.byteLength;
      var index = socket === relay.reliable ? 0 : 1;
      if (socket.bufferedAmount > relay.maxBuffered[index]) relay.maxBuffered[index] = socket.bufferedAmount;
    },

    relaySyncAll: function() {
      var runtime = HaloWebTransportRuntime;
      runtime.relayPeers.forEach(function(record) {
        var linked = runtime.relayLinked(record);
        if (linked) record.relayEverLinked = true;
        if (linked && record.needsResend) {
          record.needsResend = false;
          runtime.relayResend(record);
        }
        record.needsStateSync = true;
        runtime.syncPeerState(record);
      });
      runtime.schedulePump();
    },

    /* A peer with no path for the grace period fails, as a dead connection would. */
    relayCheckGrace: function() {
      var runtime = HaloWebTransportRuntime;
      var now = performance.now();
      Array.from(runtime.relayPeers.values()).forEach(function(record) {
        if (runtime.relayLinked(record)) {
          record.awaySince = 0;
        } else if (!record.awaySince) {
          record.awaySince = now;
        } else if (now - record.awaySince > runtime.RELAY_GRACE_MILLISECONDS) {
          runtime.failPeer(record, new Error(record.relayEverLinked ?
            'The relay connection could not be restored' :
            'Could not reach the peer through the relay'));
        }
      });
    },

    relayMessage: function(relay, socket, data) {
      var runtime = HaloWebTransportRuntime;
      var channels = runtime.RELAY_CHANNEL;
      relay.messagesReceived = (relay.messagesReceived || 0) + 1;
      relay.bytesReceived = (relay.bytesReceived || 0) + (typeof data === 'string' ? data.length : data.byteLength || 0);
      if (typeof data === 'string') {
        var message;
        try { message = JSON.parse(data); } catch (error) { return; }
        if (message.type === 'ready' && socket === relay.reliable) {
          relay.ready = true;
          runtime.relaySendPhase(relay);
          relay.reconnectAttempt = 0;
          if (relay.everReady) relay.reconnects++;
          relay.everReady = true;
          if (relay.outageStart) {
            relay.lastOutageMilliseconds = Math.round(performance.now() - relay.outageStart);
            relay.outageStart = 0;
          }
          if (message.colo) relay.colo = message.colo;
          relay.present = new Set(Array.isArray(message.peers) ? message.peers : []);
          relay.slots = new Map();
          if (message.slots && typeof message.slots === 'object') {
            Object.keys(message.slots).forEach(function(id) { runtime.relaySetSlot(relay, id, message.slots[id]); });
          }
          if (message.names && typeof message.names === 'object') {
            Object.keys(message.names).forEach(function(id) { relay.names.set(id, String(message.names[id])); });
          }
          /* Anything sent before this socket may have died with the old one. */
          runtime.relayPeers.forEach(function(record) { record.needsResend = true; });
          runtime.relaySyncAll();
          relay.present.forEach(function(id) { runtime.relayDiscover(relay, id); });
          return;
        }
        if (message.type === 'peer-up') {
          relay.present.add(message.id);
          runtime.relaySetSlot(relay, message.id, [message.slot, message.generation]);
          if (typeof message.name === 'string') relay.names.set(message.id, message.name);
          /* The peer's previous socket may have taken frames with it. */
          var returned = runtime.relayPeers.get(message.id);
          if (returned) returned.needsResend = true;
          runtime.relaySyncAll();
          runtime.relayDiscover(relay, message.id);
        } else if (message.type === 'peer-down') {
          relay.present.delete(message.id);
          relay.slots.delete(message.id);
          runtime.relaySyncAll();
        }
        return;
      }
      if (!(data instanceof ArrayBuffer) || data.byteLength < 1) return;
      var batch = new Uint8Array(data);
      if (batch[0] !== runtime.RELAY_BATCH_MARKER) {
        runtime.relayFrame(relay, socket, data);
        return;
      }
      for (var offset = 1; offset + 2 <= batch.byteLength;) {
        var length = (batch[offset] << 8) | batch[offset + 1];
        offset += 2;
        if (!length || offset + length > batch.byteLength) return;
        runtime.relayFrame(relay, socket, data.slice(offset, offset + length));
        offset += length;
      }
    },

    /* Room mode: peers come from the relay's membership instead of signaling.
       Each newly seen counterpart becomes a peer, reported to the page. */
    relayDiscover: function(relay, id) {
      var runtime = HaloWebTransportRuntime;
      if (!relay.options.rooms || runtime.relayPeers.has(id) || relay.discovering.has(id) ||
          !/^[0-9a-f]{12}$/.test(id)) return;
      relay.discovering.add(id);
      var peerId = 'relay-' + id;
      runtime.addPeer({ peerId: peerId, remoteIdentifier: id, initiator: relay.options.role === 'host' })
        .then(function() {
          var callback = runtime.options.onRelayPeer;
          if (typeof callback === 'function') {
            callback({ peerId: peerId, identifier: id, name: relay.names.get(id) || null,
              role: relay.options.role === 'host' ? 'guest' : 'host' });
          }
          /* addPeer may already have reported the peer connected, before the
             callback registered it; report the current state again. */
          var record = runtime.peersById.get(peerId);
          if (record) record.lastPublicState = null;
          runtime.relaySyncAll();
        })
        .catch(function(error) { runtime.reportError(null, error); })
        .finally(function() { relay.discovering.delete(id); });
    },

    relayFrame: function(relay, socket, data) {
      var runtime = HaloWebTransportRuntime;
      var channels = runtime.RELAY_CHANNEL;
      if (data.byteLength < runtime.RELAY_HEADER_BYTES) return;
      var bytes = new Uint8Array(data);
      var channel = bytes[0];
      var view = new DataView(data);
      if (channel === channels.ECHO) {
        if (data.byteLength >= runtime.RELAY_HEADER_BYTES + 8) {
          relay.echo[socket === relay.reliable ? 0 : 1].push(
            performance.now() - view.getFloat64(runtime.RELAY_HEADER_BYTES, true));
        }
        return;
      }
      var record = runtime.relayPeers.get(runtime.identifierText(bytes.subarray(1, 7)));
      if (!record || record.removed) return;
      var payload = runtime.RELAY_HEADER_BYTES;
      if (channel === channels.RELIABLE) {
        if (data.byteLength < payload + runtime.RELAY_SEQUENCE_BYTES) return;
        var sequence = view.getUint32(payload);
        runtime.relayAcknowledged(record, view.getUint32(payload + 4));
        if (sequence === record.rxSequence + 1) {
          record.rxSequence = sequence;
          record.ackOwed++;
          runtime.receiveChannelMessage(record, true,
            data.slice(payload + runtime.RELAY_SEQUENCE_BYTES));
        } else if (sequence <= record.rxSequence) {
          record.duplicateFrames++;
          record.ackOwed++;
        } else {
          /* A gap: the sender replays from its last acknowledgement. */
          record.outOfOrderFrames++;
        }
        if (record.ackOwed >= runtime.RELAY_ACK_EVERY) runtime.relaySendAck(record);
      } else if (channel === channels.ACK) {
        if (data.byteLength >= payload + 4) runtime.relayAcknowledged(record, view.getUint32(payload));
      } else if (channel === channels.UNRELIABLE) {
        runtime.receiveChannelMessage(record, false, data.slice(payload));
      } else if (channel === channels.PING_RELIABLE || channel === channels.PING_UNRELIABLE) {
        var reply = bytes.slice();
        reply[0] = channel + 1;
        runtime.relayQueue(socket, reply);
      } else if ((channel === channels.PONG_RELIABLE || channel === channels.PONG_UNRELIABLE) &&
                 record.relayProbes && data.byteLength >= payload + 8) {
        record.relayProbes[channel === channels.PONG_RELIABLE ? 0 : 1].push(
          performance.now() - view.getFloat64(payload, true));
      }
    },

    relayAcknowledged: function(record, acknowledgement) {
      var runtime = HaloWebTransportRuntime;
      if (acknowledgement <= record.txAcknowledged) return;
      record.txAcknowledged = acknowledgement;
      while (record.resend.length &&
             new DataView(record.resend[0].buffer).getUint32(runtime.RELAY_HEADER_BYTES) <= acknowledgement) {
        record.resendBytes -= record.resend.shift().byteLength;
      }
      if (record.relayBlocked) runtime.relayWatch();
    },

    relaySendAck: function(record) {
      var runtime = HaloWebTransportRuntime;
      if (!runtime.relayLinked(record)) return;
      var frame = new Uint8Array(runtime.RELAY_HEADER_BYTES + 4);
      frame[0] = runtime.RELAY_CHANNEL.ACK;
      frame.set(record.identifierBytes, 1);
      new DataView(frame.buffer).setUint32(runtime.RELAY_HEADER_BYTES, record.rxSequence);
      runtime.relayQueue(runtime.relay.reliable, frame, true);
      record.ackOwed = 0;
    },

    relayFlushAcks: function() {
      HaloWebTransportRuntime.relayPeers.forEach(function(record) {
        if (record.ackOwed) HaloWebTransportRuntime.relaySendAck(record);
      });
    },

    /* Replays every unacknowledged reliable frame, oldest first. */
    relayResend: function(record) {
      var runtime = HaloWebTransportRuntime;
      if (!runtime.relayLinked(record)) return;
      var socket = runtime.relay.reliable;
      record.resend.forEach(function(frame) {
        new DataView(frame.buffer).setUint32(runtime.RELAY_HEADER_BYTES + 4, record.rxSequence);
        runtime.relayQueue(socket, frame);
      });
      record.resentFrames += record.resend.length;
      record.ackOwed = 0;
    },

    relayProbeFrame: function(channel, identifier) {
      var frame = new Uint8Array(HaloWebTransportRuntime.RELAY_HEADER_BYTES + 8);
      frame[0] = channel;
      if (identifier) frame.set(identifier, 1);
      new DataView(frame.buffer).setFloat64(7, performance.now(), true);
      return frame;
    },

    /* ?netstats=1 only: peer-echoed round trips on each socket, which wait
       behind queued game frames, and relay-echoed ones for this browser's leg. */
    relayProbe: function() {
      var runtime = HaloWebTransportRuntime;
      var relay = runtime.relay;
      var channels = runtime.RELAY_CHANNEL;
      if (!relay || relay.failed || !relay.ready) return;
      runtime.relayPeers.forEach(function(record) {
        if (!runtime.relayLinked(record)) return;
        runtime.relayQueue(relay.reliable, runtime.relayProbeFrame(channels.PING_RELIABLE, record.identifierBytes), true);
        runtime.relayQueue(relay.unreliable, runtime.relayProbeFrame(channels.PING_UNRELIABLE, record.identifierBytes), true);
      });
      [relay.reliable, relay.unreliable].forEach(function(socket, index) {
        if (socket.readyState === 1 && (index === 0 || socket !== relay.reliable)) {
          runtime.relayQueue(socket, runtime.relayProbeFrame(channels.ECHO, null), true);
        }
      });
    },

    relaySend: function(record, reliable, pointer, length) {
      var runtime = HaloWebTransportRuntime;
      var relay = runtime.relay;
      var linked = runtime.relayLinked(record);
      var header = runtime.RELAY_HEADER_BYTES;
      if (!reliable) {
        var datagramSocket = linked && relay.unreliable;
        if (!datagramSocket || datagramSocket.bufferedAmount > runtime.RELAY_DATAGRAM_DROP_BYTES) {
          record.staleDatagrams++;
          return 1;
        }
        /* (batching: with the frame's other datagrams for this peer, at its end) */
        if (relay.batching) {
          (record.pendingDatagrams || (record.pendingDatagrams = [])).push(HEAPU8.slice(pointer, pointer + length));
          runtime.relayArmFlush(relay, false);
          return 1;
        }
        var datagram = new Uint8Array(header + length);
        datagram[0] = runtime.RELAY_CHANNEL.UNRELIABLE;
        datagram.set(record.identifierBytes, 1);
        datagram.set(HEAPU8.subarray(pointer, pointer + length), header);
        runtime.relayTransmit(record, datagramSocket, datagram, 1);
        return 1;
      }
      var size = header + runtime.RELAY_SEQUENCE_BYTES + length;
      /* A peer that has left this much unacknowledged is dropped (its client
         rejoins) rather than waited for: the host's writes to it would block,
         and with them its writes to everyone else. */
      if (record.resendBytes + size > runtime.RELAY_RESEND_LIMIT) {
        record.resendOverflows = (record.resendOverflows || 0) + 1;
        runtime.failPeer(record, new Error('The peer fell too far behind'));
        return 0;
      }
      if (linked && relay.reliable.bufferedAmount > runtime.RELIABLE_HIGH_WATER) {
        record.relayBlocked = true;
        record.needsStateSync = true;
        runtime.schedulePump();
        runtime.relayWatch();
        return 0;
      }
      var frame = new Uint8Array(size);
      var view = new DataView(frame.buffer);
      frame[0] = runtime.RELAY_CHANNEL.RELIABLE;
      frame.set(record.identifierBytes, 1);
      view.setUint32(header, ++record.txSequence);
      view.setUint32(header + 4, record.rxSequence);
      frame.set(HEAPU8.subarray(pointer, pointer + length), header + runtime.RELAY_SEQUENCE_BYTES);
      record.resend.push(frame);
      record.resendBytes += size;
      /* Without a path the frame waits for the replay after reconnecting. */
      if (linked) {
        record.ackOwed = 0;
        runtime.relayTransmit(record, relay.reliable, frame, 0);
      }
      return 1;
    },

    relayTransmit: function(record, socket, frame) {
      HaloWebTransportRuntime.relayQueue(socket, frame);
    },

    /* WebSocket has no bufferedamountlow event: poll while a peer is blocked. */
    relayWatch: function() {
      var runtime = HaloWebTransportRuntime;
      var relay = runtime.relay;
      if (!relay || relay.watchTimer) return;
      relay.watchTimer = setTimeout(function() {
        relay.watchTimer = 0;
        if (relay !== runtime.relay) return;
        var blocked = false;
        runtime.relayPeers.forEach(function(record) {
          if (!record.relayBlocked) return;
          if (record.resendBytes <= runtime.RELAY_RESEND_LIMIT / 2 &&
              (!relay.ready || relay.reliable.bufferedAmount <= runtime.RELIABLE_HIGH_WATER / 2)) {
            record.relayBlocked = false;
            record.needsStateSync = true;
            runtime.syncPeerState(record);
          } else {
            blocked = true;
          }
        });
        if (blocked) runtime.relayWatch();
      }, 10);
    },

    addRelayPeer: function(options, identifier, address) {
      var runtime = HaloWebTransportRuntime;
      var record = {
        peerId: options.peerId,
        identifier: runtime.identifierText(identifier),
        identifierBytes: identifier,
        address: address,
        addressText: runtime.addressText(address),
        relay: true,
        pc: null,
        reliable: null,
        unreliable: null,
        reliableQueue: [],
        unreliableQueue: [],
        reliableQueuedBytes: 0,
        unreliableQueuedBytes: 0,
        droppedDatagrams: 0,
        staleDatagrams: 0,
        relayBlocked: false,
        relayEverLinked: false,
        awaySince: 0,
        txSequence: 0,
        txAcknowledged: 0,
        rxSequence: 0,
        ackOwed: 0,
        needsResend: false,
        resend: [],
        resendBytes: 0,
        resentFrames: 0,
        duplicateFrames: 0,
        outOfOrderFrames: 0,
        relayProbes: runtime.netstatsEnabled ? [[], []] : null,
        netstats: runtime.netstatsEnabled ?
          [runtime.netstatsChannel(), runtime.netstatsChannel()] : null,
        needsStateSync: true,
        lastPublicState: null,
        removed: false,
      };
      runtime.peersById.set(record.peerId, record);
      runtime.peersByAddress.set(record.address, record);
      runtime.relayPeers.set(record.identifier, record);
      try {
        runtime.openRelay();
      } catch (error) {
        runtime.removePeer(record.peerId);
        throw error;
      }
      runtime.emitState(record, 'connecting');
      runtime.relaySyncAll();
      return {
        peerId: record.peerId,
        address: record.addressText,
        remoteIdentifier: record.identifier,
      };
    },

    install: function() {
      if (typeof window === 'undefined' || window.HaloWebTransport) return;
      var runtime = HaloWebTransportRuntime;
      runtime.netstatsUpload = typeof document !== 'undefined' && typeof document.querySelector === 'function' &&
        !!document.querySelector('meta[name="halo-netstats-upload"]');
      runtime.netstatsEnabled = runtime.netstatsUpload || (!!window.location &&
        /[?&]netstats=1(&|$)/.test(window.location.search));
      if (runtime.netstatsEnabled) runtime.startNetstatsLog();
      window.HaloWebTransport = Object.freeze({
        configure: function(options) {
          options = options || {};
          if (options.iceServers !== undefined) runtime.options.iceServers = options.iceServers;
          if (options.onSignal !== undefined) runtime.options.onSignal = options.onSignal;
          if (options.onStateChange !== undefined) runtime.options.onStateChange = options.onStateChange;
          if (options.onError !== undefined) runtime.options.onError = options.onError;
          if (options.onRelayPeer !== undefined) runtime.options.onRelayPeer = options.onRelayPeer;
          if (options.transport !== undefined) {
            if (options.transport !== 'webrtc' && options.transport !== 'relay') {
              throw new TypeError('transport must be "webrtc" or "relay"');
            }
            runtime.options.transport = options.transport;
          }
          if (options.relay !== undefined) {
            runtime.options.relay = options.relay;
            if (runtime.relay && (!options.relay ||
                runtime.relay.key !== runtime.relayKey(options.relay))) {
              runtime.closeRelay();
            }
          }
        },
        getLocalIdentifier: function() { return runtime.localIdentifier(); },
        /* Room mode: connects to the configured relay room; its members
           become peers through onRelayPeer. */
        openRelay: function() { runtime.openRelay(); },
        /* details: what the room's server-wide listing shows, {state, map,
           mode, channel} (relay.ts control) */
        setRelayPhase: function(inMatch, joinable, details) {
          var relay = runtime.relay;
          var detailsKey = details ? JSON.stringify(details) : '';
          if (!relay || (relay.inMatch === !!inMatch && relay.joinable === !!joinable &&
              (relay.phaseDetailsKey || '') === detailsKey)) return;
          relay.inMatch = !!inMatch;
          relay.joinable = !!joinable;
          relay.phaseDetails = details || null;
          relay.phaseDetailsKey = detailsKey;
          runtime.relaySendPhase(relay);
        },
        /* (a spectator) it plays now (false), or watches again (true): the
           room counts it so (the next connection says so in its auth) */
        setRelaySpectating: function(spectating) {
          var relay = runtime.relay;
          if (!relay || !relay.ready || !relay.reliable) return;
          try {
            relay.reliable.send(JSON.stringify({ type: 'spectating', value: !!spectating }));
          } catch (error) {
            /* closing: the next connection's auth says it */
          }
        },
        addPeer: function(options) { return runtime.addPeer(options); },
        handleSignal: function(peerId, signal) { return runtime.handleSignal(peerId, signal); },
        restartIce: function(peerId) { return runtime.restartIce(peerId); },
        removePeer: function(peerId) { return runtime.removePeer(peerId); },
        disconnectAll: function() {
          Array.from(runtime.peersById.keys()).forEach(function(peerId) {
            runtime.removePeer(peerId);
          });
          runtime.closeRelay();
        },
        listPeers: function() {
          return Array.from(runtime.peersById.values()).map(function(record) {
            return {
              peerId: record.peerId,
              address: record.addressText,
              state: record.lastPublicState,
              droppedDatagrams: record.droppedDatagrams,
              staleDatagrams: record.relay ? record.staleDatagrams : undefined,
            };
          });
        },
        getStats: async function(peerId) {
          var record = runtime.peersById.get(peerId);
          if (!record || record.removed) throw new Error('Unknown peer: ' + peerId);
          return record.pc ? record.pc.getStats() : new Map();
        },
        /* Only with ?netstats=1: the logged windows, oldest first (an hour). */
        netStats: function() {
          if (!runtime.netstatsEnabled) throw new Error('Open the page with ?netstats=1');
          return runtime.netstatsHistory.slice();
        },
        /* Only with ?netstats=1: closes the relay sockets as a network failure
           would, to exercise reconnecting. */
        debugDropRelay: function() {
          if (!runtime.netstatsEnabled) throw new Error('Open the page with ?netstats=1');
          if (runtime.relay) runtime.relayCloseSockets(runtime.relay, 4999);
        },
        /* Whether this browser can run a transport: the configured one, or
           the one named, so a page can check before configuring. */
        isSupported: function(transport) {
          return (transport || runtime.options.transport) === 'relay' ?
            typeof WebSocket === 'function' : typeof RTCPeerConnection === 'function';
        },
      });
    },
  },

  web_transport_send__deps: ['$HaloWebTransportRuntime'],
  web_transport_send__proxy: 'sync',
  web_transport_send__sig: 'iiiii',
  web_transport_send: function(address, reliable, buffer, length) {
    return HaloWebTransportRuntime.send(address, reliable, buffer, length);
  },

  /* Once per game frame while a batching transport is open. */
  web_transport_flush__deps: ['$HaloWebTransportRuntime'],
  web_transport_flush__proxy: 'sync',
  web_transport_flush__sig: 'v',
  web_transport_flush: function() {
    HaloWebTransportRuntime.relayFlush();
  },
});
