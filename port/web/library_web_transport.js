/* Browser transports for the browser socket adapter.

   The public API is window.HaloWebTransport.  Signalling is deliberately
   supplied by the page: this module owns peer connections and DataChannels,
   but does not know whether offers travel through a Worker, a local test
   harness, or another signalling service.  With configure({ transport:
   'relay' }) the same peers travel through a WebSocket relay
   (services/relay) instead, and take no signals. */

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
      }
      if (typeof Module['_platform_web_profile_take_gap_maximum'] === 'function') {
        game.frameGapMaxMs = +Module['_platform_web_profile_take_gap_maximum']().toFixed(1);
        game.frameHitches = Module['_platform_web_profile_hitches']();
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
          };
          record.relayProbes = [[], []];
          record.netstatsStale = record.staleDatagrams;
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
        };
        relay.echo = [[], []];
        relay.maxBuffered = [0, 0];
      }
      runtime.netstatsWindow = { time: now, game: game };
      return {
        at: new Date().toISOString(),
        windowSeconds: +seconds.toFixed(2),
        visibility: document.visibilityState,
        transport: runtime.options.transport,
        game: {
          ticksPerSecond: delta('ticks') === null ? null : +(delta('ticks') / seconds).toFixed(1),
          ownCorrections: delta('ownCorrections'),
          ownCorrectionMaxUnits: game.ownCorrectionMaxUnits,
          rejectedPredictions: delta('rejectedPredictions'),
          frameGapMaxMs: game.frameGapMaxMs,
          frameHitches: delta('frameHitches'),
        },
        peers: peers,
        relay: relaySummary,
      };
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
      runtime.netstatsTakeWindow();
      setInterval(function() {
        runtime.netstatsTakeWindow().then(function(stats) {
          runtime.netstatsHistory.push(stats);
          if (runtime.netstatsHistory.length > runtime.NETSTATS_HISTORY_WINDOWS) {
            runtime.netstatsHistory.shift();
          }
          console.info('[netstats] ' + JSON.stringify(stats));
        });
      }, runtime.NETSTATS_LOG_MILLISECONDS);
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
       binary message is [channel][6-byte peer identifier][Halo frame]; the
       relay replaces the identifier with the sender's.  TCP never drops, so
       a datagram that would wait behind a backed-up socket is dropped here
       instead, as a network would drop it. */
    RELAY_CHANNEL: Object.freeze({
      RELIABLE: 0, UNRELIABLE: 1, PING_RELIABLE: 2, PONG_RELIABLE: 3,
      PING_UNRELIABLE: 4, PONG_UNRELIABLE: 5, ECHO: 6,
    }),
    RELAY_HEADER_BYTES: 7,
    RELAY_DATAGRAM_DROP_BYTES: 4096,
    RELAY_PROBE_MILLISECONDS: 100,
    relayPeers: new Map(),
    relay: null,

    relayKey: function(options) {
      return [options.url, options.roomId, options.role, options.sockets].join('|');
    },

    relayReady: function(record) {
      var relay = HaloWebTransportRuntime.relay;
      return !!relay && !relay.failed && relay.reliable.readyState === 1 &&
        relay.unreliable.readyState === 1 && relay.present.has(record.identifier);
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
      var base = new URL(options.url);
      if (base.protocol === 'http:') base.protocol = 'ws:';
      if (base.protocol === 'https:') base.protocol = 'wss:';
      var relay = {
        key: key,
        present: new Set(),
        failed: false,
        probeTimer: 0,
        watchTimer: 0,
        echo: [[], []],
        maxBuffered: [0, 0],
        reliable: null,
        unreliable: null,
      };
      var identifier = runtime.localIdentifier();
      var open = function(kind) {
        var url = new URL('v1/rooms/' + encodeURIComponent(options.roomId) + '/ws',
          base.href.replace(/\/?$/, '/'));
        url.search = new URLSearchParams({ role: options.role, id: identifier, ch: kind }).toString();
        var socket = new WebSocket(url.href);
        socket.binaryType = 'arraybuffer';
        socket.onopen = function() { runtime.relaySyncAll(); };
        socket.onmessage = function(event) { runtime.relayMessage(relay, socket, event.data); };
        socket.onclose = function(event) {
          runtime.relayFailed(relay, 'The relay connection closed (' + event.code + ')');
        };
        return socket;
      };
      runtime.relay = relay;
      if (options.sockets === 2) {
        relay.reliable = open('r');
        relay.unreliable = open('u');
      } else {
        relay.reliable = relay.unreliable = open('both');
      }
      if (runtime.netstatsEnabled) {
        relay.probeTimer = setInterval(runtime.relayProbe, runtime.RELAY_PROBE_MILLISECONDS);
      }
    },

    closeRelay: function() {
      var runtime = HaloWebTransportRuntime;
      var relay = runtime.relay;
      if (!relay) return;
      runtime.relay = null;
      relay.failed = true;
      clearInterval(relay.probeTimer);
      clearTimeout(relay.watchTimer);
      [relay.reliable, relay.unreliable].forEach(function(socket) {
        socket.onclose = null;
        try { socket.close(1000); } catch (error) { /* already closed */ }
      });
    },

    relayFailed: function(relay, message) {
      var runtime = HaloWebTransportRuntime;
      if (relay !== runtime.relay) return;
      runtime.closeRelay();
      Array.from(runtime.relayPeers.values()).forEach(function(record) {
        runtime.failPeer(record, new Error(message));
      });
    },

    relaySyncAll: function() {
      var runtime = HaloWebTransportRuntime;
      runtime.relayPeers.forEach(function(record) {
        record.needsStateSync = true;
        runtime.syncPeerState(record);
      });
      runtime.schedulePump();
    },

    relayMessage: function(relay, socket, data) {
      var runtime = HaloWebTransportRuntime;
      var channels = runtime.RELAY_CHANNEL;
      if (relay !== runtime.relay) return;
      if (typeof data === 'string') {
        var message;
        try { message = JSON.parse(data); } catch (error) { return; }
        if (message.type === 'ready' && Array.isArray(message.peers)) {
          message.peers.forEach(function(id) { relay.present.add(id); });
          if (message.colo && socket === relay.reliable) relay.colo = message.colo;
        } else if (message.type === 'peer-up') {
          relay.present.add(message.id);
        } else if (message.type === 'peer-down') {
          relay.present.delete(message.id);
          var departed = runtime.relayPeers.get(message.id);
          if (departed) runtime.failPeer(departed, new Error('The peer left the relay'));
        }
        runtime.relaySyncAll();
        return;
      }
      if (!(data instanceof ArrayBuffer) || data.byteLength < runtime.RELAY_HEADER_BYTES) return;
      var bytes = new Uint8Array(data);
      var channel = bytes[0];
      if (channel === channels.ECHO) {
        if (data.byteLength >= runtime.RELAY_HEADER_BYTES + 8) {
          relay.echo[socket === relay.reliable ? 0 : 1].push(
            performance.now() - new DataView(data, runtime.RELAY_HEADER_BYTES, 8).getFloat64(0, true));
        }
        return;
      }
      var record = runtime.relayPeers.get(runtime.identifierText(bytes.subarray(1, 7)));
      if (!record || record.removed) return;
      if (channel === channels.RELIABLE || channel === channels.UNRELIABLE) {
        runtime.receiveChannelMessage(record, channel === channels.RELIABLE,
          data.slice(runtime.RELAY_HEADER_BYTES));
      } else if (channel === channels.PING_RELIABLE || channel === channels.PING_UNRELIABLE) {
        var reply = bytes.slice();
        reply[0] = channel + 1;
        socket.send(reply);
      } else if ((channel === channels.PONG_RELIABLE || channel === channels.PONG_UNRELIABLE) &&
                 record.relayProbes && data.byteLength >= runtime.RELAY_HEADER_BYTES + 8) {
        record.relayProbes[channel === channels.PONG_RELIABLE ? 0 : 1].push(
          performance.now() - new DataView(data, runtime.RELAY_HEADER_BYTES, 8).getFloat64(0, true));
      }
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
      if (!relay || relay.failed) return;
      runtime.relayPeers.forEach(function(record) {
        if (!runtime.relayReady(record)) return;
        relay.reliable.send(runtime.relayProbeFrame(channels.PING_RELIABLE, record.identifierBytes));
        relay.unreliable.send(runtime.relayProbeFrame(channels.PING_UNRELIABLE, record.identifierBytes));
      });
      [relay.reliable, relay.unreliable].forEach(function(socket, index) {
        if (socket.readyState === 1 && (index === 0 || socket !== relay.reliable)) {
          socket.send(runtime.relayProbeFrame(channels.ECHO, null));
        }
      });
    },

    relaySend: function(record, reliable, pointer, length) {
      var runtime = HaloWebTransportRuntime;
      var relay = runtime.relay;
      if (!runtime.relayReady(record)) {
        record.needsStateSync = true;
        runtime.schedulePump();
        return 0;
      }
      var socket = reliable ? relay.reliable : relay.unreliable;
      if (reliable && socket.bufferedAmount > runtime.RELIABLE_HIGH_WATER) {
        record.relayBlocked = true;
        record.needsStateSync = true;
        runtime.schedulePump();
        runtime.relayWatch();
        return 0;
      }
      if (!reliable && socket.bufferedAmount > runtime.RELAY_DATAGRAM_DROP_BYTES) {
        record.staleDatagrams++;
        return 1;
      }
      var frame = new Uint8Array(runtime.RELAY_HEADER_BYTES + length);
      frame[0] = reliable ? runtime.RELAY_CHANNEL.RELIABLE : runtime.RELAY_CHANNEL.UNRELIABLE;
      frame.set(record.identifierBytes, 1);
      frame.set(HEAPU8.subarray(pointer, pointer + length), runtime.RELAY_HEADER_BYTES);
      try {
        socket.send(frame);
      } catch (error) {
        runtime.reportError(record, error);
        record.needsStateSync = true;
        runtime.schedulePump();
        return 0;
      }
      var index = socket === relay.reliable ? 0 : 1;
      if (socket.bufferedAmount > relay.maxBuffered[index]) relay.maxBuffered[index] = socket.bufferedAmount;
      return 1;
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
          if (relay.reliable.bufferedAmount <= runtime.RELIABLE_HIGH_WATER / 2) {
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
      runtime.syncPeerState(record);
      return {
        peerId: record.peerId,
        address: record.addressText,
        remoteIdentifier: record.identifier,
      };
    },

    install: function() {
      if (typeof window === 'undefined' || window.HaloWebTransport) return;
      var runtime = HaloWebTransportRuntime;
      runtime.netstatsEnabled = !!window.location &&
        /[?&]netstats=1(&|$)/.test(window.location.search);
      if (runtime.netstatsEnabled) runtime.startNetstatsLog();
      window.HaloWebTransport = Object.freeze({
        configure: function(options) {
          options = options || {};
          if (options.iceServers !== undefined) runtime.options.iceServers = options.iceServers;
          if (options.onSignal !== undefined) runtime.options.onSignal = options.onSignal;
          if (options.onStateChange !== undefined) runtime.options.onStateChange = options.onStateChange;
          if (options.onError !== undefined) runtime.options.onError = options.onError;
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
        isSupported: function() {
          return runtime.options.transport === 'relay' ?
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
});
