(() => {
  function even(value, minimum) { return Math.max(minimum, Math.floor(value / 2) * 2); }

  function applyRenderLimit(width, height, renderLimit, minimumWidth, minimumHeight) {
    if (!renderLimit) return { width, height };
    const scale = Math.min(1, Number(renderLimit.width) / width, Number(renderLimit.height) / height);
    return { width: even(width * scale, minimumWidth), height: even(height * scale, minimumHeight) };
  }

  function resolve(options = {}) {
    const viewportWidth = Math.max(1, Number(options.viewportWidth) || 1);
    const viewportHeight = Math.max(1, Number(options.viewportHeight) || 1);
    if (options.mobile === true) {
      const dpr = Math.max(1, Math.min(4, Number(options.devicePixelRatio) || 1));
      const longestEdge = options.qualityMode === "smooth" ? 1920 : 2560;
      const scale = Math.min(dpr, longestEdge / Math.max(viewportWidth, viewportHeight));
      const routeLimited = applyRenderLimit(viewportWidth * scale, viewportHeight * scale, options.route === "turn" ? { width: 1920, height: 1080 } : null, 2, 2);
      const limited = applyRenderLimit(routeLimited.width, routeLimited.height, options.renderLimit, 2, 2);
      return { ...limited, width: even(limited.width, 2), height: even(limited.height, 2), landscape: limited.width > limited.height };
    }


    const heightFloor = Math.max(360, viewportHeight, 640 * viewportHeight / viewportWidth);
    const aspect = viewportWidth / viewportHeight;
    const dpr = Math.min(2, Math.max(1, Number(options.devicePixelRatio) || 1));
    let height = options.publicVisit === true ? Math.max(heightFloor * dpr, 720) : Math.max(heightFloor * dpr, 1080);
    let width = height * aspect;
    const native4k = options.route === "lanP2p" || ((options.route === "publicP2p" || options.route === "turn" && options.qualityMode === "quality") && options.allow4k === true);
    const pixelScale = Math.min(1, (native4k ? 3840 : 3440) / Math.max(width, height), Math.sqrt((native4k ? 8_294_400 : 5_000_000) / (width * height)));
    width *= pixelScale; height *= pixelScale;
    const turnLimit = options.route === "turn" ? options.qualityMode === "quality" && options.allow4k === true ? { width: 3840, height: 2160 } : options.qualityMode === "smooth" ? { width: 1920, height: 1080 } : { width: 2560, height: 1440 } : null;
    const routeLimited = applyRenderLimit(width, height, turnLimit, 2, 2);
    const limited = applyRenderLimit(routeLimited.width, routeLimited.height, options.renderLimit, 2, 2);
    return { width: even(limited.width, 2), height: even(limited.height, 2), landscape: limited.width > limited.height };
  }

  globalThis.PeerStreamResolutionPolicy = Object.freeze({ resolve });
})();
