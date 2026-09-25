// Loads qodercli's embedded auth wasm module (credential storage encryption).
//
// The wasm is embedded as a base64 string inside the CLI bundle, so we extract
// it at runtime from the user's installed CLI — this keeps the module in sync
// with whatever CLI version is installed and avoids redistributing the binary.
//
// The wasm-bindgen ABI mirrors the bundle's own glue: strings are passed as
// (ptr, len) via malloc (__wbindgen_export2); results come back as (ptr, len)
// through a stack-allocated return area, followed by a JS heap error pair.

const fs = require('fs');
const path = require('path');

const WASM_MAGIC_BASE64 = 'AGFzbQE';

// Find the qodercli bundle on PATH. Returns the path to bundle/<cli>.js.
function resolveCliBundlePath(command) {
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const candidates = process.platform === 'win32'
    ? [`${command}.cmd`, `${command}.exe`, command]
    : [command];

  for (const dir of dirs) {
    for (const name of candidates) {
      const candidate = path.join(dir, name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
      } catch {
        continue;
      }
      const resolved = fs.realpathSync(candidate);
      if (resolved.endsWith('.js')) return resolved;
      // Windows shim: the bundle lives under the package's node_modules tree
      for (const pkg of ['@qoder-ai/qodercli', '@qodercn-ai/qoderclicn']) {
        const bundle = path.join(dir, 'node_modules', pkg, 'bundle', `${command}.js`);
        if (fs.existsSync(bundle)) return bundle;
      }
    }
  }
  return null;
}

// Extract the embedded auth wasm from the CLI bundle. There may be several
// embedded wasms; the auth module is the one exporting credential_storage_decrypt.
function extractAuthWasm(bundlePath, cacheDir) {
  const stat = fs.statSync(bundlePath);
  const cacheFile = cacheDir
    ? path.join(cacheDir, `qoder-auth-${stat.size}-${Math.floor(stat.mtimeMs)}.wasm`)
    : null;
  if (cacheFile && fs.existsSync(cacheFile)) return cacheFile;

  const source = fs.readFileSync(bundlePath, 'utf8');
  const re = /["'`](AGFzbQE[A-Za-z0-9+/=]{1000,})["'`]/g;
  let match;
  while ((match = re.exec(source))) {
    const bytes = Buffer.from(match[1], 'base64');
    try {
      const mod = new WebAssembly.Module(bytes);
      const exports = WebAssembly.Module.exports(mod).map((e) => e.name);
      if (exports.includes('credential_storage_decrypt')) {
        if (cacheFile) {
          fs.mkdirSync(cacheDir, { recursive: true });
          fs.writeFileSync(cacheFile, bytes);
        }
        return cacheFile || bytes;
      }
    } catch {
      // not a valid wasm literal — keep looking
    }
  }
  throw new Error('auth wasm module not found in the qodercli bundle');
}

async function loadAuthWasm(wasmSource) {
  const bytes = Buffer.isBuffer(wasmSource) ? wasmSource : fs.readFileSync(wasmSource);

  const heap = new Array(1024).fill(undefined);
  heap.push(undefined, null, true, false);
  let heapNext = heap.length;

  const getObject = (i) => heap[i];
  const addHeapObject = (obj) => {
    if (heapNext === heap.length) heap.push(heap.length + 1);
    const idx = heapNext;
    heapNext = heap[idx];
    heap[idx] = obj;
    return idx;
  };
  const dropObject = (idx) => {
    if (idx < 1028) return;
    heap[idx] = heapNext;
    heapNext = idx;
  };
  const takeObject = (idx) => {
    const obj = getObject(idx);
    dropObject(idx);
    return obj;
  };

  let wasm;
  let cachedMem = null;
  const mem = () => {
    if (!cachedMem || cachedMem.buffer !== wasm.memory.buffer) {
      cachedMem = new Uint8Array(wasm.memory.buffer);
    }
    return cachedMem;
  };
  const getArrayU8 = (ptr, len) => mem().subarray(ptr >>> 0, (ptr >>> 0) + len);

  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const encoder = new TextEncoder();
  const getString = (ptr, len) => decoder.decode(getArrayU8(ptr, len));

  let wasmVectorLen = 0;
  const passString = (str) => {
    const encoded = encoder.encode(str);
    const ptr = wasm.__wbindgen_export2(encoded.length, 1) >>> 0;
    mem().set(encoded, ptr);
    wasmVectorLen = encoded.length;
    return ptr;
  };

  const handleError = (fn, args) => {
    try {
      return fn.apply(null, args);
    } catch (err) {
      wasm.__wbindgen_export(addHeapObject(err));
      return undefined;
    }
  };

  const maybeHeap = (value) => (value === null || value === undefined ? 0 : addHeapObject(value));

  const imports = {
    './qoder_auth_wasm_bg.js': {
      __wbindgen_object_drop_ref: (i) => takeObject(i),
      __wbindgen_object_clone_ref: (i) => addHeapObject(getObject(i)),
      __wbindgen_cast_0000000000000001: (p, l) => addHeapObject(getArrayU8(p, l)),
      __wbindgen_cast_0000000000000002: (p, l) => addHeapObject(getString(p, l)),
      __wbg_set_08463b1df38a7e29: (a, b, c) => addHeapObject(getObject(a).set(getObject(b), getObject(c))),
      __wbg_getRandomValues_d49329ff89a07af1: (...args) => handleError((a, b) => { globalThis.crypto.getRandomValues(getArrayU8(a, b)); }, args),
      __wbg_crypto_38df2bab126b63dc: (a) => addHeapObject(getObject(a).crypto),
      __wbg_process_44c7a14e11e9f69e: (a) => addHeapObject(getObject(a).process),
      __wbg_versions_276b2795b1c6a219: (a) => addHeapObject(getObject(a).versions),
      __wbg_node_84ea875411254db1: (a) => addHeapObject(getObject(a).node),
      __wbg_require_b4edbdcf3e2a1ef0: (...args) => handleError(() => addHeapObject(module.require), args),
      __wbg_msCrypto_bd5a034af96bcba6: (a) => addHeapObject(getObject(a).msCrypto),
      __wbg_getRandomValues_c44a50d8cfdaebeb: (...args) => handleError((a, b) => { getObject(a).getRandomValues(getObject(b)); }, args),
      __wbg_randomFillSync_6c25eac9869eb53c: (...args) => handleError((a, b) => { getObject(a).randomFillSync(takeObject(b)); }, args),
      __wbg_call_d578befcc3145dee: (...args) => handleError((a, b, c) => getObject(a).call(getObject(b), getObject(c)), args),
      __wbg_new_with_length_9cedd08484b73942: (l) => addHeapObject(new Uint8Array(l >>> 0)),
      __wbg_length_0c32cb8543c8e4c8: (a) => getObject(a).length,
      __wbg_prototypesetcall_3e05eb9545565046: (a, b, c) => { Uint8Array.prototype.set.call(getArrayU8(a, b), getObject(c)); },
      __wbg_subarray_0f98d3fb634508ad: (a, b, c) => addHeapObject(getObject(a).subarray(b, c)),
      __wbg_new_99cabae501c0a8a0: () => addHeapObject(new Map()),
      __wbg_now_88621c9c9a4f3ffc: () => Date.now(),
      __wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f: () => maybeHeap(typeof globalThis === 'undefined' ? null : globalThis),
      __wbg_static_accessor_SELF_24f78b6d23f286ea: () => maybeHeap(typeof self === 'undefined' ? null : self),
      __wbg_static_accessor_GLOBAL_f2e0f995a21329ff: () => maybeHeap(typeof global === 'undefined' ? null : global),
      __wbg_static_accessor_WINDOW_59fd959c540fe405: () => maybeHeap(typeof window === 'undefined' ? null : window),
      __wbg___wbindgen_throw_81fc77679af83bc6: (p, l) => { throw new Error(getString(p, l)); },
      __wbg_Error_2e59b1b37a9a34c3: (p, l) => addHeapObject(new Error(getString(p, l))),
      __wbg___wbindgen_is_object_40c5a80572e8f9d3: (a) => {
        const obj = getObject(a);
        return typeof obj === 'object' && obj !== null ? 1 : 0;
      },
      __wbg___wbindgen_is_string_b29b5c5a8065ba1a: (a) => (typeof getObject(a) === 'string' ? 1 : 0),
      __wbg___wbindgen_is_function_49868bde5eb1e745: (a) => (typeof getObject(a) === 'function' ? 1 : 0),
      __wbg___wbindgen_is_undefined_c0cca72b82b86f4d: (a) => (getObject(a) === undefined ? 1 : 0),
    },
  };

  const { instance } = await WebAssembly.instantiate(bytes, imports);
  wasm = instance.exports;

  function callStringString(fn, a, b) {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
    const p0 = passString(a);
    const l0 = wasmVectorLen;
    const p1 = passString(b);
    const l1 = wasmVectorLen;
    let r0 = 0;
    let r1 = 0;
    try {
      fn(retptr, p0, l0, p1, l1);
      const data = new DataView(wasm.memory.buffer);
      r0 = data.getInt32(retptr, true);
      r1 = data.getInt32(retptr + 4, true);
      const errObj = data.getInt32(retptr + 8, true);
      const errFlag = data.getInt32(retptr + 12, true);
      if (errFlag !== 0) throw takeObject(errObj);
      return getString(r0, r1);
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
      wasm.__wbindgen_export4(r0, r1, 1);
    }
  }

  // Allocate several strings up front; returns [[ptr, len], ...]. Capturing the
  // length right after each allocation mirrors the bundle's Pg pattern (the
  // shared vector-len register is overwritten by the next passString).
  const passStrings = (strs) => strs.map((s) => {
    if (s === null || s === undefined) return [0, 0];
    const ptr = passString(s);
    return [ptr, wasmVectorLen];
  });

  // --- QoderContext: agent-endpoint request preparation ----------------------
  // Mirrors the bundle's QoderContext + RequestResult wrappers:
  //   new QoderContext(uid, encrypt_user_info, credsJson, extra?)
  //   refreshAuthFields(userInfoJson)                    -> void
  //   prepareInferRequest(endpoint, bodyJson, modelKey, modelSource) -> RequestResult
  //   RequestResult: url (string), headers (heap object), body (string)
  // Return-area layouts (little-endian):
  //   ptr-returning fns: [+0 ptr][+4 errObj][+8 errFlag]
  //   string-returning fns: [+0 ptr][+4 len][+8 errObj][+12 errFlag]
  //   void fns: [+0 errObj][+4 errFlag]

  const dv = () => new DataView(wasm.memory.buffer);

  function qoderContextNew(a, b, c, d) {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
    const [[p0, l0], [p1, l1], [p2, l2], [p3, l3]] = passStrings([a, b, c, d]);
    try {
      wasm.qodercontext_new(retptr, p0, l0, p1, l1, p2, l2, p3, l3);
      const data = dv();
      const errObj = data.getInt32(retptr + 4, true);
      if (data.getInt32(retptr + 8, true) !== 0) throw takeObject(errObj);
      return data.getInt32(retptr, true) >>> 0;
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }

  function refreshAuthFields(ctxPtr, json) {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
    const [[p0, l0]] = passStrings([json]);
    try {
      wasm.qodercontext_refreshAuthFields(retptr, ctxPtr, p0, l0);
      const data = dv();
      const errObj = data.getInt32(retptr, true);
      if (data.getInt32(retptr + 4, true) !== 0) throw takeObject(errObj);
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }

  function prepareInferRequest(ctxPtr, endpoint, bodyJson, modelKey, modelSource) {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
    const [[pA, lA], [pE, lE], [pT, lT], [pI, lI]] = passStrings([endpoint, bodyJson, modelKey, modelSource]);
    try {
      wasm.qodercontext_prepareInferRequest(retptr, ctxPtr, pA, lA, pE, lE, pT, lT, pI, lI);
      const data = dv();
      const errObj = data.getInt32(retptr + 4, true);
      if (data.getInt32(retptr + 8, true) !== 0) throw takeObject(errObj);
      return data.getInt32(retptr, true) >>> 0;
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }

  function requestResultString(fnName, rrPtr) {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
    let p = 0;
    let l = 0;
    try {
      wasm[fnName](retptr, rrPtr);
      const data = dv();
      p = data.getInt32(retptr, true);
      l = data.getInt32(retptr + 4, true);
      const errObj = data.getInt32(retptr + 8, true);
      if (data.getInt32(retptr + 12, true) !== 0) throw takeObject(errObj);
      return getString(p, l);
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
      if (p !== 0) wasm.__wbindgen_export4(p, l, 1);
    }
  }

  function createQoderContext(userInfoJson) {
    const ctxPtr = qoderContextNew('', '', JSON.stringify({ uid: '', encrypt_user_info: '', key: '' }), undefined);
    let freed = false;
    return {
      refreshAuthFields: (json) => refreshAuthFields(ctxPtr, json),
      prepareInferRequest(endpoint, bodyJson, modelKey, modelSource) {
        const rrPtr = prepareInferRequest(ctxPtr, endpoint, bodyJson, modelKey, modelSource);
        let rrFreed = false;
        return {
          url: requestResultString('requestresult_url', rrPtr),
          body: requestResultString('requestresult_body', rrPtr),
          headers: takeObject(wasm.requestresult_headers(rrPtr)),
          free() {
            if (!rrFreed) { rrFreed = true; wasm.__wbg_requestresult_free(rrPtr, 0); }
          },
        };
      },
      free() {
        if (!freed) { freed = true; wasm.__wbg_qodercontext_free(ctxPtr, 0); }
      },
    };
  }

  return {
    credentialStorageDecrypt: (ciphertext, key) => callStringString(wasm.credential_storage_decrypt, ciphertext, key),
    credentialStorageEncrypt: (plaintext, key) => callStringString(wasm.credential_storage_encrypt, plaintext, key),
    // Inverse of the Encode=1 request/response transform — diagnostics tool
    // for decoding captured CLI traffic.
    decryptServerResponse: (payload) => callStringString(wasm.decrypt_server_response, payload, ''),
    createQoderContext,
  };
}

module.exports = {
  extractAuthWasm,
  loadAuthWasm,
  resolveCliBundlePath,
};
