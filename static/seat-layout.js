(function (root) {
  "use strict";

  // Compact portrait tables use reserved ring slots around the board. Wide
  // tables keep the same evenly spaced ellipse supplied by the renderer.
  var MOBILE_RINGS = {
    2: [[50, 94], [50, 16]],
    3: [[50, 94], [32, 12], [68, 12]],
    4: [[50, 94], [7, 55], [50, 10], [93, 55]],
    5: [[50, 94], [18, 84], [32, 14], [68, 14], [82, 84]],
    6: [[50, 94], [16, 85], [7, 30], [50, 10], [93, 30], [84, 85]],
    7: [[50, 94], [0, 85], [0, 60], [38, 10], [62, 10], [100, 60], [100, 85]],
    8: [[50, 94], [0, 85], [0, 60], [0, 35], [38, 10], [62, 10], [100, 35], [100, 60]],
    9: [[50, 94], [0, 85], [0, 60], [0, 35], [38, 10], [62, 10], [100, 35], [100, 60], [100, 85]]
  };

  var SHORT_RINGS = {
    7: [[50, 94], [0, 85], [0, 60], [38, 10], [62, 10], [100, 60], [100, 85]],
    8: [[50, 94], [0, 85], [0, 60], [0, 35], [38, 10], [62, 10], [100, 35], [100, 60]],
    9: [[50, 94], [0, 85], [0, 60], [0, 35], [38, 10], [62, 10], [100, 35], [100, 60], [100, 85]]
  };

  // Short landscape can fit two readable rows of seats. Stagger the ring
  // horizontally across those rows instead of stacking cards along the sides.
  // At tiny phone widths, keep all nine seats in three stable bands:
  // four at the top, two outside the board, and three along the bottom.
  var TINY_RINGS = {
    7: [[50, 85], [18, 85], [0, 50], [0, 15], [100, 15], [100, 50], [82, 85]],
    8: [[50, 85], [18, 85], [0, 50], [0, 15], [38, 15], [62, 15], [100, 15], [82, 85]],
    9: [[50, 85], [18, 85], [0, 50], [0, 15], [38, 15], [62, 15], [100, 15], [100, 50], [82, 85]]
  };

  var LANDSCAPE_RINGS = {
    // Keep the central board lane clear in a shallow viewport by moving the
    // usual top-center opponent into an upper corner. The hero stays bottom-center.
    2: [[50, 94], [16, 15]],
    4: [[50, 94], [7, 62], [16, 15], [93, 62]],
    6: [[50, 94], [5, 90], [5, 10], [24, 10], [95, 10], [95, 90]],
    7: [[50, 94], [22, 90], [5, 90], [5, 10], [95, 10], [95, 90], [78, 90]],
    8: [[50, 94], [22, 90], [5, 90], [5, 10], [24, 10], [76, 10], [95, 10], [78, 90]],
    9: [[50, 94], [22, 90], [5, 90], [5, 10], [24, 10], [76, 10], [95, 10], [95, 90], [78, 90]]
  };

  var WIDE_RINGS = {
    7: [[50, 92], [22, 84], [5, 62], [30, 10], [70, 10], [95, 62], [78, 84]],
    8: [[50, 92], [22, 84], [5, 62], [5, 30], [30, 10], [70, 10], [95, 30], [95, 62]],
    9: [[50, 92], [22, 84], [5, 62], [5, 30], [30, 10], [70, 10], [95, 30], [95, 62], [78, 84]]
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
    var tinyPortrait = viewportWidth <= 340 && viewportHeight <= 600 && viewportHeight >= viewportWidth;
    var shortWide = viewportWidth > viewportHeight && viewportWidth < 1000 && viewportHeight < 500;
    var ring = shortWide
      ? LANDSCAPE_RINGS[seats.length]
      : (tinyPortrait
        ? (TINY_RINGS[seats.length] || MOBILE_RINGS[seats.length])
        : (compact ? ((shortPortrait && SHORT_RINGS[seats.length]) || MOBILE_RINGS[seats.length]) : WIDE_RINGS[seats.length]));
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
