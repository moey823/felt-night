(function (root) {
  "use strict";

  // Compact portrait tables use reserved ring slots around the board. Wide
  // tables keep the same evenly spaced ellipse supplied by the renderer.
  var MOBILE_RINGS = {
    2: [[50, 92], [50, 22]],
    3: [[50, 92], [34, 12], [66, 12]],
    4: [[50, 92], [20, 84], [50, 12], [80, 84]],
    5: [[50, 92], [18, 88], [8, 30], [92, 30], [82, 88]],
    6: [[50, 92], [18, 88], [8, 70], [50, 14], [92, 70], [82, 88]],
    7: [[50, 92], [18, 88], [8, 70], [32, 14], [68, 14], [92, 70], [82, 88]],
    8: [[50, 92], [16, 88], [8, 70], [8, 27], [50, 9], [92, 27], [92, 70], [84, 88]],
    9: [[50, 92], [16, 88], [8, 70], [8, 27], [32, 9], [68, 9], [92, 27], [92, 70], [84, 88]]
  };

  var SHORT_RINGS = {
    7: [[50, 92], [18, 88], [8, 70], [32, 14], [68, 14], [92, 70], [82, 88]],
    8: [[50, 92], [16, 88], [8, 70], [8, 27], [50, 9], [92, 27], [92, 70], [84, 88]],
    9: [[50, 92], [16, 88], [8, 70], [8, 27], [32, 9], [68, 9], [92, 27], [92, 70], [84, 88]]
  };

  var LANDSCAPE_RINGS = {
    7: [[50, 92], [28, 82], [8, 60], [30, 12], [70, 12], [92, 60], [72, 82]],
    8: [[50, 92], [28, 82], [8, 60], [8, 32], [50, 12], [92, 32], [92, 60], [72, 82]],
    9: [[50, 92], [28, 82], [8, 60], [8, 32], [32, 12], [68, 12], [92, 32], [92, 60], [72, 82]]
  };

  function number(value, fallback) {
    var result = Number(value);
    return Number.isFinite(result) ? result : fallback;
  }

  function clamp(value, low, high) {
    if (high < low) return (low + high) / 2;
    return Math.max(low, Math.min(high, value));
  }

  function relativeIndex(seat, index, seats, width, height) {
    var explicit = seat.relativeIndex != null ? seat.relativeIndex : seat.index;
    var parsed = Number(explicit);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed % seats.length;
    if (seat.hero) return 0;

    var sourceAngle = Math.atan2(number(seat.y, height / 2) - height / 2,
      number(seat.x, width / 2) - width / 2);
    var offset = (sourceAngle - Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
    return Math.round(offset / (Math.PI * 2 / seats.length)) % seats.length;
  }

  function fit(input) {
    input = input || {};
    var width = Math.max(0, number(input.width, 0));
    var height = Math.max(0, number(input.height, 0));
    var seats = Array.isArray(input.seats) ? input.seats : [];
    if (!seats.length) return [];

    var viewportWidth = Math.max(0, number(input.viewportWidth, number(root.innerWidth, width)));
    var viewportHeight = Math.max(0, number(input.viewportHeight, number(root.innerHeight, height)));
    var compact = viewportWidth < 780;
    var shortPortrait = compact && viewportHeight < 640;
    var shortWide = !compact && viewportWidth < 900 && viewportHeight < 600;
    var ring = compact
      ? ((shortPortrait && SHORT_RINGS[seats.length]) || MOBILE_RINGS[seats.length])
      : (shortWide ? LANDSCAPE_RINGS[seats.length] : null);
    return seats.map(function (source, index) {
      var seat = source || {};
      var x = number(seat.x, width / 2);
      var y = number(seat.y, height / 2);
      if (ring) {
        var slot = ring[relativeIndex(seat, index, seats, width, height)] || ring[index];
        if (slot) {
          var halfWidth = Math.max(1, number(seat.width, 82)) / 2;
          var halfHeight = Math.max(1, number(seat.height, 80)) / 2;
          x = clamp(width * slot[0] / 100, halfWidth + 4, width - halfWidth - 4);
          y = clamp(height * slot[1] / 100, halfHeight + 4, height - halfHeight - 4);
        }
      }
      return {
        id: seat.id,
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100
      };
    });
  }

  root.SitNgoLayout = { fit: fit };
})(typeof window !== "undefined" ? window : globalThis);
