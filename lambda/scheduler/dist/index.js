import { createRequire } from 'module'; const require = createRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/dayjs/dayjs.min.js
var require_dayjs_min = __commonJS({
  "node_modules/dayjs/dayjs.min.js"(exports, module) {
    !function(t, e) {
      "object" == typeof exports && "undefined" != typeof module ? module.exports = e() : "function" == typeof define && define.amd ? define(e) : (t = "undefined" != typeof globalThis ? globalThis : t || self).dayjs = e();
    }(exports, function() {
      "use strict";
      var t = 1e3, e = 6e4, n = 36e5, r = "millisecond", i = "second", s = "minute", u = "hour", a = "day", o = "week", c = "month", f = "quarter", h = "year", d = "date", l = "Invalid Date", $ = /^(\d{4})[-/]?(\d{1,2})?[-/]?(\d{0,2})[Tt\s]*(\d{1,2})?:?(\d{1,2})?:?(\d{1,2})?[.:]?(\d+)?$/, y = /\[([^\]]+)]|Y{1,4}|M{1,4}|D{1,2}|d{1,4}|H{1,2}|h{1,2}|a|A|m{1,2}|s{1,2}|Z{1,2}|SSS/g, M = { name: "en", weekdays: "Sunday_Monday_Tuesday_Wednesday_Thursday_Friday_Saturday".split("_"), months: "January_February_March_April_May_June_July_August_September_October_November_December".split("_"), ordinal: function(t2) {
        var e2 = ["th", "st", "nd", "rd"], n2 = t2 % 100;
        return "[" + t2 + (e2[(n2 - 20) % 10] || e2[n2] || e2[0]) + "]";
      } }, m = function(t2, e2, n2) {
        var r2 = String(t2);
        return !r2 || r2.length >= e2 ? t2 : "" + Array(e2 + 1 - r2.length).join(n2) + t2;
      }, v = { s: m, z: function(t2) {
        var e2 = -t2.utcOffset(), n2 = Math.abs(e2), r2 = Math.floor(n2 / 60), i2 = n2 % 60;
        return (e2 <= 0 ? "+" : "-") + m(r2, 2, "0") + ":" + m(i2, 2, "0");
      }, m: function t2(e2, n2) {
        if (e2.date() < n2.date()) return -t2(n2, e2);
        var r2 = 12 * (n2.year() - e2.year()) + (n2.month() - e2.month()), i2 = e2.clone().add(r2, c), s2 = n2 - i2 < 0, u2 = e2.clone().add(r2 + (s2 ? -1 : 1), c);
        return +(-(r2 + (n2 - i2) / (s2 ? i2 - u2 : u2 - i2)) || 0);
      }, a: function(t2) {
        return t2 < 0 ? Math.ceil(t2) || 0 : Math.floor(t2);
      }, p: function(t2) {
        return { M: c, y: h, w: o, d: a, D: d, h: u, m: s, s: i, ms: r, Q: f }[t2] || String(t2 || "").toLowerCase().replace(/s$/, "");
      }, u: function(t2) {
        return void 0 === t2;
      } }, g = "en", D = {};
      D[g] = M;
      var p = "$isDayjsObject", S = function(t2) {
        return t2 instanceof _ || !(!t2 || !t2[p]);
      }, w = function t2(e2, n2, r2) {
        var i2;
        if (!e2) return g;
        if ("string" == typeof e2) {
          var s2 = e2.toLowerCase();
          D[s2] && (i2 = s2), n2 && (D[s2] = n2, i2 = s2);
          var u2 = e2.split("-");
          if (!i2 && u2.length > 1) return t2(u2[0]);
        } else {
          var a2 = e2.name;
          D[a2] = e2, i2 = a2;
        }
        return !r2 && i2 && (g = i2), i2 || !r2 && g;
      }, O = function(t2, e2) {
        if (S(t2)) return t2.clone();
        var n2 = "object" == typeof e2 ? e2 : {};
        return n2.date = t2, n2.args = arguments, new _(n2);
      }, b = v;
      b.l = w, b.i = S, b.w = function(t2, e2) {
        return O(t2, { locale: e2.$L, utc: e2.$u, x: e2.$x, $offset: e2.$offset });
      };
      var _ = function() {
        function M2(t2) {
          this.$L = w(t2.locale, null, true), this.parse(t2), this.$x = this.$x || t2.x || {}, this[p] = true;
        }
        var m2 = M2.prototype;
        return m2.parse = function(t2) {
          this.$d = function(t3) {
            var e2 = t3.date, n2 = t3.utc;
            if (null === e2) return /* @__PURE__ */ new Date(NaN);
            if (b.u(e2)) return /* @__PURE__ */ new Date();
            if (e2 instanceof Date) return new Date(e2);
            if ("string" == typeof e2 && !/Z$/i.test(e2)) {
              var r2 = e2.match($);
              if (r2) {
                var i2 = r2[2] - 1 || 0, s2 = (r2[7] || "0").substring(0, 3);
                return n2 ? new Date(Date.UTC(r2[1], i2, r2[3] || 1, r2[4] || 0, r2[5] || 0, r2[6] || 0, s2)) : new Date(r2[1], i2, r2[3] || 1, r2[4] || 0, r2[5] || 0, r2[6] || 0, s2);
              }
            }
            return new Date(e2);
          }(t2), this.init();
        }, m2.init = function() {
          var t2 = this.$d;
          this.$y = t2.getFullYear(), this.$M = t2.getMonth(), this.$D = t2.getDate(), this.$W = t2.getDay(), this.$H = t2.getHours(), this.$m = t2.getMinutes(), this.$s = t2.getSeconds(), this.$ms = t2.getMilliseconds();
        }, m2.$utils = function() {
          return b;
        }, m2.isValid = function() {
          return !(this.$d.toString() === l);
        }, m2.isSame = function(t2, e2) {
          var n2 = O(t2);
          return this.startOf(e2) <= n2 && n2 <= this.endOf(e2);
        }, m2.isAfter = function(t2, e2) {
          return O(t2) < this.startOf(e2);
        }, m2.isBefore = function(t2, e2) {
          return this.endOf(e2) < O(t2);
        }, m2.$g = function(t2, e2, n2) {
          return b.u(t2) ? this[e2] : this.set(n2, t2);
        }, m2.unix = function() {
          return Math.floor(this.valueOf() / 1e3);
        }, m2.valueOf = function() {
          return this.$d.getTime();
        }, m2.startOf = function(t2, e2) {
          var n2 = this, r2 = !!b.u(e2) || e2, f2 = b.p(t2), l2 = function(t3, e3) {
            var i2 = b.w(n2.$u ? Date.UTC(n2.$y, e3, t3) : new Date(n2.$y, e3, t3), n2);
            return r2 ? i2 : i2.endOf(a);
          }, $2 = function(t3, e3) {
            return b.w(n2.toDate()[t3].apply(n2.toDate("s"), (r2 ? [0, 0, 0, 0] : [23, 59, 59, 999]).slice(e3)), n2);
          }, y2 = this.$W, M3 = this.$M, m3 = this.$D, v2 = "set" + (this.$u ? "UTC" : "");
          switch (f2) {
            case h:
              return r2 ? l2(1, 0) : l2(31, 11);
            case c:
              return r2 ? l2(1, M3) : l2(0, M3 + 1);
            case o:
              var g2 = this.$locale().weekStart || 0, D2 = (y2 < g2 ? y2 + 7 : y2) - g2;
              return l2(r2 ? m3 - D2 : m3 + (6 - D2), M3);
            case a:
            case d:
              return $2(v2 + "Hours", 0);
            case u:
              return $2(v2 + "Minutes", 1);
            case s:
              return $2(v2 + "Seconds", 2);
            case i:
              return $2(v2 + "Milliseconds", 3);
            default:
              return this.clone();
          }
        }, m2.endOf = function(t2) {
          return this.startOf(t2, false);
        }, m2.$set = function(t2, e2) {
          var n2, o2 = b.p(t2), f2 = "set" + (this.$u ? "UTC" : ""), l2 = (n2 = {}, n2[a] = f2 + "Date", n2[d] = f2 + "Date", n2[c] = f2 + "Month", n2[h] = f2 + "FullYear", n2[u] = f2 + "Hours", n2[s] = f2 + "Minutes", n2[i] = f2 + "Seconds", n2[r] = f2 + "Milliseconds", n2)[o2], $2 = o2 === a ? this.$D + (e2 - this.$W) : e2;
          if (o2 === c || o2 === h) {
            var y2 = this.clone().set(d, 1);
            y2.$d[l2]($2), y2.init(), this.$d = y2.set(d, Math.min(this.$D, y2.daysInMonth())).$d;
          } else l2 && this.$d[l2]($2);
          return this.init(), this;
        }, m2.set = function(t2, e2) {
          return this.clone().$set(t2, e2);
        }, m2.get = function(t2) {
          return this[b.p(t2)]();
        }, m2.add = function(r2, f2) {
          var d2, l2 = this;
          r2 = Number(r2);
          var $2 = b.p(f2), y2 = function(t2) {
            var e2 = O(l2);
            return b.w(e2.date(e2.date() + Math.round(t2 * r2)), l2);
          };
          if ($2 === c) return this.set(c, this.$M + r2);
          if ($2 === h) return this.set(h, this.$y + r2);
          if ($2 === a) return y2(1);
          if ($2 === o) return y2(7);
          var M3 = (d2 = {}, d2[s] = e, d2[u] = n, d2[i] = t, d2)[$2] || 1, m3 = this.$d.getTime() + r2 * M3;
          return b.w(m3, this);
        }, m2.subtract = function(t2, e2) {
          return this.add(-1 * t2, e2);
        }, m2.format = function(t2) {
          var e2 = this, n2 = this.$locale();
          if (!this.isValid()) return n2.invalidDate || l;
          var r2 = t2 || "YYYY-MM-DDTHH:mm:ssZ", i2 = b.z(this), s2 = this.$H, u2 = this.$m, a2 = this.$M, o2 = n2.weekdays, c2 = n2.months, f2 = n2.meridiem, h2 = function(t3, n3, i3, s3) {
            return t3 && (t3[n3] || t3(e2, r2)) || i3[n3].slice(0, s3);
          }, d2 = function(t3) {
            return b.s(s2 % 12 || 12, t3, "0");
          }, $2 = f2 || function(t3, e3, n3) {
            var r3 = t3 < 12 ? "AM" : "PM";
            return n3 ? r3.toLowerCase() : r3;
          };
          return r2.replace(y, function(t3, r3) {
            return r3 || function(t4) {
              switch (t4) {
                case "YY":
                  return String(e2.$y).slice(-2);
                case "YYYY":
                  return b.s(e2.$y, 4, "0");
                case "M":
                  return a2 + 1;
                case "MM":
                  return b.s(a2 + 1, 2, "0");
                case "MMM":
                  return h2(n2.monthsShort, a2, c2, 3);
                case "MMMM":
                  return h2(c2, a2);
                case "D":
                  return e2.$D;
                case "DD":
                  return b.s(e2.$D, 2, "0");
                case "d":
                  return String(e2.$W);
                case "dd":
                  return h2(n2.weekdaysMin, e2.$W, o2, 2);
                case "ddd":
                  return h2(n2.weekdaysShort, e2.$W, o2, 3);
                case "dddd":
                  return o2[e2.$W];
                case "H":
                  return String(s2);
                case "HH":
                  return b.s(s2, 2, "0");
                case "h":
                  return d2(1);
                case "hh":
                  return d2(2);
                case "a":
                  return $2(s2, u2, true);
                case "A":
                  return $2(s2, u2, false);
                case "m":
                  return String(u2);
                case "mm":
                  return b.s(u2, 2, "0");
                case "s":
                  return String(e2.$s);
                case "ss":
                  return b.s(e2.$s, 2, "0");
                case "SSS":
                  return b.s(e2.$ms, 3, "0");
                case "Z":
                  return i2;
              }
              return null;
            }(t3) || i2.replace(":", "");
          });
        }, m2.utcOffset = function() {
          return 15 * -Math.round(this.$d.getTimezoneOffset() / 15);
        }, m2.diff = function(r2, d2, l2) {
          var $2, y2 = this, M3 = b.p(d2), m3 = O(r2), v2 = (m3.utcOffset() - this.utcOffset()) * e, g2 = this - m3, D2 = function() {
            return b.m(y2, m3);
          };
          switch (M3) {
            case h:
              $2 = D2() / 12;
              break;
            case c:
              $2 = D2();
              break;
            case f:
              $2 = D2() / 3;
              break;
            case o:
              $2 = (g2 - v2) / 6048e5;
              break;
            case a:
              $2 = (g2 - v2) / 864e5;
              break;
            case u:
              $2 = g2 / n;
              break;
            case s:
              $2 = g2 / e;
              break;
            case i:
              $2 = g2 / t;
              break;
            default:
              $2 = g2;
          }
          return l2 ? $2 : b.a($2);
        }, m2.daysInMonth = function() {
          return this.endOf(c).$D;
        }, m2.$locale = function() {
          return D[this.$L];
        }, m2.locale = function(t2, e2) {
          if (!t2) return this.$L;
          var n2 = this.clone(), r2 = w(t2, e2, true);
          return r2 && (n2.$L = r2), n2;
        }, m2.clone = function() {
          return b.w(this.$d, this);
        }, m2.toDate = function() {
          return new Date(this.valueOf());
        }, m2.toJSON = function() {
          return this.isValid() ? this.toISOString() : null;
        }, m2.toISOString = function() {
          return this.$d.toISOString();
        }, m2.toString = function() {
          return this.$d.toUTCString();
        }, M2;
      }(), k = _.prototype;
      return O.prototype = k, [["$ms", r], ["$s", i], ["$m", s], ["$H", u], ["$W", a], ["$M", c], ["$y", h], ["$D", d]].forEach(function(t2) {
        k[t2[1]] = function(e2) {
          return this.$g(e2, t2[0], t2[1]);
        };
      }), O.extend = function(t2, e2) {
        return t2.$i || (t2(e2, _, O), t2.$i = true), O;
      }, O.locale = w, O.isDayjs = S, O.unix = function(t2) {
        return O(1e3 * t2);
      }, O.en = D[g], O.Ls = D, O.p = {}, O;
    });
  }
});

// node_modules/dayjs/plugin/utc.js
var require_utc = __commonJS({
  "node_modules/dayjs/plugin/utc.js"(exports, module) {
    !function(t, i) {
      "object" == typeof exports && "undefined" != typeof module ? module.exports = i() : "function" == typeof define && define.amd ? define(i) : (t = "undefined" != typeof globalThis ? globalThis : t || self).dayjs_plugin_utc = i();
    }(exports, function() {
      "use strict";
      var t = "minute", i = /[+-]\d\d(?::?\d\d)?/g, e = /([+-]|\d\d)/g;
      return function(s, f, n) {
        var u = f.prototype;
        n.utc = function(t2) {
          var i2 = { date: t2, utc: true, args: arguments };
          return new f(i2);
        }, u.utc = function(i2) {
          var e2 = n(this.toDate(), { locale: this.$L, utc: true });
          return i2 ? e2.add(this.utcOffset(), t) : e2;
        }, u.local = function() {
          return n(this.toDate(), { locale: this.$L, utc: false });
        };
        var r = u.parse;
        u.parse = function(t2) {
          t2.utc && (this.$u = true), this.$utils().u(t2.$offset) || (this.$offset = t2.$offset), r.call(this, t2);
        };
        var o = u.init;
        u.init = function() {
          if (this.$u) {
            var t2 = this.$d;
            this.$y = t2.getUTCFullYear(), this.$M = t2.getUTCMonth(), this.$D = t2.getUTCDate(), this.$W = t2.getUTCDay(), this.$H = t2.getUTCHours(), this.$m = t2.getUTCMinutes(), this.$s = t2.getUTCSeconds(), this.$ms = t2.getUTCMilliseconds();
          } else o.call(this);
        };
        var a = u.utcOffset;
        u.utcOffset = function(s2, f2) {
          var n2 = this.$utils().u;
          if (n2(s2)) return this.$u ? 0 : n2(this.$offset) ? a.call(this) : this.$offset;
          if ("string" == typeof s2 && (s2 = function(t2) {
            void 0 === t2 && (t2 = "");
            var s3 = t2.match(i);
            if (!s3) return null;
            var f3 = ("" + s3[0]).match(e) || ["-", 0, 0], n3 = f3[0], u3 = 60 * +f3[1] + +f3[2];
            return 0 === u3 ? 0 : "+" === n3 ? u3 : -u3;
          }(s2), null === s2)) return this;
          var u2 = Math.abs(s2) <= 16 ? 60 * s2 : s2;
          if (0 === u2) return this.utc(f2);
          var r2 = this.clone();
          if (f2) return r2.$offset = u2, r2.$u = false, r2;
          var o2 = this.$u ? this.toDate().getTimezoneOffset() : -1 * this.utcOffset();
          return (r2 = this.local().add(u2 + o2, t)).$offset = u2, r2.$x.$localOffset = o2, r2;
        };
        var h = u.format;
        u.format = function(t2) {
          var i2 = t2 || (this.$u ? "YYYY-MM-DDTHH:mm:ss[Z]" : "");
          return h.call(this, i2);
        }, u.valueOf = function() {
          var t2 = this.$utils().u(this.$offset) ? 0 : this.$offset + (this.$x.$localOffset || this.$d.getTimezoneOffset());
          return this.$d.valueOf() - 6e4 * t2;
        }, u.isUTC = function() {
          return !!this.$u;
        }, u.toISOString = function() {
          return this.toDate().toISOString();
        }, u.toString = function() {
          return this.toDate().toUTCString();
        };
        var l = u.toDate;
        u.toDate = function(t2) {
          return "s" === t2 && this.$offset ? n(this.format("YYYY-MM-DD HH:mm:ss:SSS")).toDate() : l.call(this);
        };
        var c = u.diff;
        u.diff = function(t2, i2, e2) {
          if (t2 && this.$u === t2.$u) return c.call(this, t2, i2, e2);
          var s2 = this.local(), f2 = n(t2).local();
          return c.call(s2, f2, i2, e2);
        };
      };
    });
  }
});

// node_modules/dayjs/plugin/timezone.js
var require_timezone = __commonJS({
  "node_modules/dayjs/plugin/timezone.js"(exports, module) {
    !function(t, e) {
      "object" == typeof exports && "undefined" != typeof module ? module.exports = e() : "function" == typeof define && define.amd ? define(e) : (t = "undefined" != typeof globalThis ? globalThis : t || self).dayjs_plugin_timezone = e();
    }(exports, function() {
      "use strict";
      var t = { year: 0, month: 1, day: 2, hour: 3, minute: 4, second: 5 }, e = {};
      return function(n, i, o) {
        var r, a = function(t2, n2, i2) {
          void 0 === i2 && (i2 = {});
          var o2 = new Date(t2), r2 = function(t3, n3) {
            void 0 === n3 && (n3 = {});
            var i3 = n3.timeZoneName || "short", o3 = t3 + "|" + i3, r3 = e[o3];
            return r3 || (r3 = new Intl.DateTimeFormat("en-US", { hour12: false, timeZone: t3, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: i3 }), e[o3] = r3), r3;
          }(n2, i2);
          return r2.formatToParts(o2);
        }, u = function(e2, n2) {
          for (var i2 = a(e2, n2), r2 = [], u2 = 0; u2 < i2.length; u2 += 1) {
            var f2 = i2[u2], s2 = f2.type, m = f2.value, c = t[s2];
            c >= 0 && (r2[c] = parseInt(m, 10));
          }
          var d = r2[3], l = 24 === d ? 0 : d, h = r2[0] + "-" + r2[1] + "-" + r2[2] + " " + l + ":" + r2[4] + ":" + r2[5] + ":000", v = +e2;
          return (o.utc(h).valueOf() - (v -= v % 1e3)) / 6e4;
        }, f = i.prototype;
        f.tz = function(t2, e2) {
          void 0 === t2 && (t2 = r);
          var n2, i2 = this.utcOffset(), a2 = this.toDate(), u2 = a2.toLocaleString("en-US", { timeZone: t2 }), f2 = Math.round((a2 - new Date(u2)) / 1e3 / 60), s2 = 15 * -Math.round(a2.getTimezoneOffset() / 15) - f2;
          if (!Number(s2)) n2 = this.utcOffset(0, e2);
          else if (n2 = o(u2, { locale: this.$L }).$set("millisecond", this.$ms).utcOffset(s2, true), e2) {
            var m = n2.utcOffset();
            n2 = n2.add(i2 - m, "minute");
          }
          return n2.$x.$timezone = t2, n2;
        }, f.offsetName = function(t2) {
          var e2 = this.$x.$timezone || o.tz.guess(), n2 = a(this.valueOf(), e2, { timeZoneName: t2 }).find(function(t3) {
            return "timezonename" === t3.type.toLowerCase();
          });
          return n2 && n2.value;
        };
        var s = f.startOf;
        f.startOf = function(t2, e2) {
          if (!this.$x || !this.$x.$timezone) return s.call(this, t2, e2);
          var n2 = o(this.format("YYYY-MM-DD HH:mm:ss:SSS"), { locale: this.$L });
          return s.call(n2, t2, e2).tz(this.$x.$timezone, true);
        }, o.tz = function(t2, e2, n2) {
          var i2 = n2 && e2, a2 = n2 || e2 || r, f2 = u(+o(), a2);
          if ("string" != typeof t2) return o(t2).tz(a2);
          var s2 = function(t3, e3, n3) {
            var i3 = t3 - 60 * e3 * 1e3, o2 = u(i3, n3);
            if (e3 === o2) return [i3, e3];
            var r2 = u(i3 -= 60 * (o2 - e3) * 1e3, n3);
            return o2 === r2 ? [i3, o2] : [t3 - 60 * Math.min(o2, r2) * 1e3, Math.max(o2, r2)];
          }(o.utc(t2, i2).valueOf(), f2, a2), m = s2[0], c = s2[1], d = o(m).utcOffset(c);
          return d.$x.$timezone = a2, d;
        }, o.tz.guess = function() {
          return Intl.DateTimeFormat().resolvedOptions().timeZone;
        }, o.tz.setDefault = function(t2) {
          r = t2;
        };
      };
    });
  }
});

// src/utils/logger.ts
var Logger = class _Logger {
  level;
  context;
  constructor(level = "info") {
    this.level = level;
    this.context = {};
  }
  shouldLog(level) {
    const levels = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3
    };
    return levels[level] >= levels[this.level];
  }
  formatMessage(level, message, extra) {
    const logEntry = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      level: level.toUpperCase(),
      message,
      ...this.context,
      ...extra
    };
    return JSON.stringify(logEntry);
  }
  setContext(context) {
    this.context = { ...this.context, ...context };
  }
  clearContext() {
    this.context = {};
  }
  setLevel(level) {
    this.level = level;
  }
  debug(message, extra) {
    if (this.shouldLog("debug")) {
      console.log(this.formatMessage("debug", message, extra));
    }
  }
  info(message, extra) {
    if (this.shouldLog("info")) {
      console.log(this.formatMessage("info", message, extra));
    }
  }
  warn(message, extra) {
    if (this.shouldLog("warn")) {
      console.warn(this.formatMessage("warn", message, extra));
    }
  }
  error(message, error, extra) {
    if (this.shouldLog("error")) {
      const errorDetails = { ...extra };
      if (error instanceof Error) {
        errorDetails.errorMessage = error.message;
        errorDetails.stack = error.stack;
      } else if (error) {
        errorDetails.errorMessage = String(error);
      }
      console.error(this.formatMessage("error", message, errorDetails));
    }
  }
  // Create a child logger with additional context
  child(context) {
    const childLogger = new _Logger(this.level);
    childLogger.context = { ...this.context, ...context };
    return childLogger;
  }
};
var logLevel = process.env.LOG_LEVEL || "info";
var logger = new Logger(logLevel);

// src/services/dynamodb-service.ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand
} from "@aws-sdk/lib-dynamodb";

// node_modules/uuid/dist/esm/stringify.js
var byteToHex = [];
for (let i = 0; i < 256; ++i) {
  byteToHex.push((i + 256).toString(16).slice(1));
}
function unsafeStringify(arr, offset = 0) {
  return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}

// node_modules/uuid/dist/esm/rng.js
import { randomFillSync } from "crypto";
var rnds8Pool = new Uint8Array(256);
var poolPtr = rnds8Pool.length;
function rng() {
  if (poolPtr > rnds8Pool.length - 16) {
    randomFillSync(rnds8Pool);
    poolPtr = 0;
  }
  return rnds8Pool.slice(poolPtr, poolPtr += 16);
}

// node_modules/uuid/dist/esm/native.js
import { randomUUID } from "crypto";
var native_default = { randomUUID };

// node_modules/uuid/dist/esm/v4.js
function v4(options, buf, offset) {
  if (native_default.randomUUID && !buf && !options) {
    return native_default.randomUUID();
  }
  options = options || {};
  const rnds = options.random ?? options.rng?.() ?? rng();
  if (rnds.length < 16) {
    throw new Error("Random bytes length must be >= 16");
  }
  rnds[6] = rnds[6] & 15 | 64;
  rnds[8] = rnds[8] & 63 | 128;
  if (buf) {
    offset = offset || 0;
    if (offset < 0 || offset + 16 > buf.length) {
      throw new RangeError(`UUID byte range ${offset}:${offset + 15} is out of buffer bounds`);
    }
    for (let i = 0; i < 16; ++i) {
      buf[offset + i] = rnds[i];
    }
    return buf;
  }
  return unsafeStringify(rnds);
}
var v4_default = v4;

// src/utils/time-utils.ts
var import_dayjs = __toESM(require_dayjs_min(), 1);
var import_utc = __toESM(require_utc(), 1);
var import_timezone = __toESM(require_timezone(), 1);
import_dayjs.default.extend(import_utc.default);
import_dayjs.default.extend(import_timezone.default);
function isCurrentTimeInRange(startTime, endTime, tz, activeDays) {
  const now = (0, import_dayjs.default)().tz(tz);
  const currentDay = now.format("ddd");
  const isActiveDay = activeDays.some(
    (day) => day.toLowerCase() === currentDay.toLowerCase()
  );
  if (!isActiveDay) {
    return false;
  }
  const currentDate = now.format("YYYY-MM-DD");
  const startTimeToday = import_dayjs.default.tz(`${currentDate} ${startTime}`, "YYYY-MM-DD HH:mm:ss", tz);
  let endTimeToday = import_dayjs.default.tz(`${currentDate} ${endTime}`, "YYYY-MM-DD HH:mm:ss", tz);
  if (endTimeToday.isBefore(startTimeToday)) {
    endTimeToday = endTimeToday.add(1, "day");
  }
  return now.isAfter(startTimeToday) && now.isBefore(endTimeToday);
}
function calculateTTL(daysFromNow) {
  return Math.floor(Date.now() / 1e3) + daysFromNow * 24 * 60 * 60;
}

// src/services/dynamodb-service.ts
var APP_TABLE_NAME = process.env.APP_TABLE_NAME || "cost-optimization-scheduler-app-table";
var AUDIT_TABLE_NAME = process.env.AUDIT_TABLE_NAME || "cost-optimization-scheduler-audit-table";
var AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "ap-south-1";
var DEFAULT_TENANT_ID = "org-default";
var docClient = null;
function getDynamoDBClient() {
  if (!docClient) {
    const clientConfig = { region: AWS_REGION };
    clientConfig.credentials = defaultProvider({
      profile: process.env.AWS_PROFILE
    });
    const client = new DynamoDBClient(clientConfig);
    docClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: {
        removeUndefinedValues: true
      }
    });
  }
  return docClient;
}
async function fetchActiveSchedules() {
  const client = getDynamoDBClient();
  const params = {
    TableName: APP_TABLE_NAME,
    IndexName: "GSI3",
    KeyConditionExpression: "gsi3pk = :statusVal",
    ExpressionAttributeValues: {
      ":statusVal": "STATUS#active"
    }
  };
  try {
    const response = await client.send(new QueryCommand(params));
    logger.debug(`Fetched ${response.Items?.length || 0} active schedules via GSI3`);
    return response.Items || [];
  } catch (error) {
    logger.error("Error fetching schedules from DynamoDB via GSI3", error);
    try {
      const fallbackParams = {
        TableName: APP_TABLE_NAME,
        IndexName: "GSI1",
        KeyConditionExpression: "gsi1pk = :typeVal",
        FilterExpression: "active = :activeVal",
        ExpressionAttributeValues: {
          ":typeVal": "TYPE#SCHEDULE",
          ":activeVal": true
        }
      };
      const fallbackResponse = await client.send(new QueryCommand(fallbackParams));
      logger.warn("Fallback: Fetched schedules via GSI1");
      return fallbackResponse.Items || [];
    } catch (fallbackError) {
      logger.error("Fallback fetch also failed", fallbackError);
      return [];
    }
  }
}
async function fetchScheduleById(scheduleId, tenantId = DEFAULT_TENANT_ID) {
  const client = getDynamoDBClient();
  const statuses = ["active", "inactive"];
  for (const status of statuses) {
    try {
      const response = await client.send(new QueryCommand({
        TableName: APP_TABLE_NAME,
        IndexName: "GSI3",
        KeyConditionExpression: "gsi3pk = :gsi3pk AND gsi3sk = :gsi3sk",
        ExpressionAttributeValues: {
          ":gsi3pk": `STATUS#${status}`,
          ":gsi3sk": `TENANT#${tenantId}#SCHEDULE#${scheduleId}`
        }
      }));
      if (response.Items && response.Items.length > 0) {
        return response.Items[0];
      }
    } catch (error) {
      logger.error(`Error searching GSI3 for status: ${status}`, error, { scheduleId, tenantId });
    }
  }
  logger.warn("Schedule not found in GSI3", { scheduleId, tenantId });
  return null;
}
async function fetchActiveAccounts() {
  const client = getDynamoDBClient();
  const params = {
    TableName: APP_TABLE_NAME,
    IndexName: "GSI3",
    KeyConditionExpression: "gsi3pk = :statusVal",
    FilterExpression: "#type = :typeVal",
    ExpressionAttributeNames: {
      "#type": "type"
    },
    ExpressionAttributeValues: {
      ":statusVal": "STATUS#active",
      ":typeVal": "account"
    }
  };
  try {
    const response = await client.send(new QueryCommand(params));
    logger.debug(`Fetched ${response.Items?.length || 0} active accounts via GSI3`);
    return response.Items || [];
  } catch (error) {
    logger.error("Error fetching accounts from DynamoDB via GSI3", error);
    try {
      const fallbackParams = {
        TableName: APP_TABLE_NAME,
        IndexName: "GSI1",
        KeyConditionExpression: "gsi1pk = :typeVal",
        FilterExpression: "active = :activeVal",
        ExpressionAttributeValues: {
          ":typeVal": "TYPE#ACCOUNT",
          ":activeVal": true
        }
      };
      const response = await client.send(new QueryCommand(fallbackParams));
      return response.Items || [];
    } catch (fallbackError) {
      logger.error("Fallback account fetch failed", fallbackError);
      return [];
    }
  }
}
async function createAuditLog(entry) {
  if (!AUDIT_TABLE_NAME) {
    logger.warn("AUDIT_TABLE_NAME not configured, skipping audit log");
    return;
  }
  const client = getDynamoDBClient();
  const id = v4_default();
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const ttl = calculateTTL(90);
  const item = {
    pk: `LOG#${id}`,
    sk: timestamp,
    gsi1pk: "TYPE#LOG",
    gsi1sk: timestamp,
    ttl,
    id,
    timestamp,
    ...entry
  };
  try {
    await client.send(new PutCommand({
      TableName: AUDIT_TABLE_NAME,
      Item: item
    }));
    logger.debug("Audit log created", { id, eventType: entry.eventType });
  } catch (error) {
    logger.error("Failed to create audit log", error);
  }
}
async function createExecutionAuditLog(executionId, schedule, metadata, summary, userEmail) {
  if (!AUDIT_TABLE_NAME) {
    logger.warn("AUDIT_TABLE_NAME not configured, skipping execution audit log");
    return;
  }
  const ec2Summary = {
    started: metadata.ec2.filter((r) => r.action === "start" && r.status === "success").length,
    stopped: metadata.ec2.filter((r) => r.action === "stop" && r.status === "success").length,
    failed: metadata.ec2.filter((r) => r.status === "failed").length,
    skipped: metadata.ec2.filter((r) => r.action === "skip").length
  };
  const ecsSummary = {
    started: metadata.ecs.filter((r) => r.action === "start" && r.status === "success").length,
    stopped: metadata.ecs.filter((r) => r.action === "stop" && r.status === "success").length,
    failed: metadata.ecs.filter((r) => r.status === "failed").length,
    skipped: metadata.ecs.filter((r) => r.action === "skip").length
  };
  const rdsSummary = {
    started: metadata.rds.filter((r) => r.action === "start" && r.status === "success").length,
    stopped: metadata.rds.filter((r) => r.action === "stop" && r.status === "success").length,
    failed: metadata.rds.filter((r) => r.status === "failed").length,
    skipped: metadata.rds.filter((r) => r.action === "skip").length
  };
  const overallStatus = summary.resourcesFailed > 0 ? summary.resourcesStarted + summary.resourcesStopped > 0 ? "warning" : "error" : "success";
  const details = [
    `Execution ${executionId} for schedule "${schedule.name}" completed.`,
    `EC2: ${ec2Summary.started} started, ${ec2Summary.stopped} stopped, ${ec2Summary.failed} failed, ${ec2Summary.skipped} skipped.`,
    `ECS: ${ecsSummary.started} started, ${ecsSummary.stopped} stopped, ${ecsSummary.failed} failed, ${ecsSummary.skipped} skipped.`,
    `RDS: ${rdsSummary.started} started, ${rdsSummary.stopped} stopped, ${rdsSummary.failed} failed, ${rdsSummary.skipped} skipped.`,
    `Duration: ${summary.duration}ms`
  ].join(" ");
  await createAuditLog({
    type: "audit_log",
    eventType: "scheduler.execution.complete",
    action: "execution_complete",
    user: userEmail || "system",
    userType: userEmail ? "user" : "system",
    resourceType: "scheduler",
    resourceId: executionId,
    status: overallStatus,
    details,
    severity: summary.resourcesFailed > 0 ? "medium" : "info",
    metadata: {
      executionId,
      scheduleId: schedule.scheduleId,
      scheduleName: schedule.name,
      duration: summary.duration,
      summary: {
        total: {
          started: summary.resourcesStarted,
          stopped: summary.resourcesStopped,
          failed: summary.resourcesFailed
        },
        ec2: ec2Summary,
        ecs: ecsSummary,
        rds: rdsSummary
      },
      schedule_metadata: metadata
    }
  });
  logger.info("Execution audit log created", { executionId, scheduleId: schedule.scheduleId });
}

// src/services/execution-history-service.ts
import {
  PutCommand as PutCommand2,
  QueryCommand as QueryCommand2,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";
var EXECUTION_TTL_DAYS = 30;
var buildExecutionPK = (tenantId, scheduleId) => `TENANT#${tenantId}#SCHEDULE#${scheduleId}`;
var buildExecutionSK = (timestamp, executionId) => `EXEC#${timestamp}#${executionId}`;
async function createExecutionRecord(params) {
  const client = getDynamoDBClient();
  const executionId = v4_default();
  const startTime = (/* @__PURE__ */ new Date()).toISOString();
  const tenantId = params.tenantId || DEFAULT_TENANT_ID;
  const accountId = params.accountId || "unknown";
  const record = {
    executionId,
    scheduleId: params.scheduleId,
    scheduleName: params.scheduleName,
    tenantId,
    accountId,
    status: "running",
    triggeredBy: params.triggeredBy,
    startTime,
    resourcesStarted: 0,
    resourcesStopped: 0,
    resourcesFailed: 0,
    ttl: calculateTTL(EXECUTION_TTL_DAYS)
  };
  const item = {
    pk: buildExecutionPK(tenantId, params.scheduleId),
    sk: buildExecutionSK(startTime, executionId),
    gsi1pk: "TYPE#EXECUTION",
    gsi1sk: `${startTime}#${executionId}`,
    type: "execution",
    ...record
  };
  try {
    await client.send(new PutCommand2({
      TableName: APP_TABLE_NAME,
      Item: item
    }));
    logger.info(`Execution record created: ${executionId}`, {
      scheduleId: params.scheduleId,
      executionId
    });
    return record;
  } catch (error) {
    logger.error("Failed to create execution record", error);
    throw error;
  }
}
async function updateExecutionRecord(record, updates) {
  const client = getDynamoDBClient();
  const endTime = (/* @__PURE__ */ new Date()).toISOString();
  const duration = new Date(endTime).getTime() - new Date(record.startTime).getTime();
  const updateExpressions = [
    "set #status = :status",
    "endTime = :endTime",
    "#duration = :duration"
  ];
  const expressionAttributeNames = {
    "#status": "status",
    "#duration": "duration"
  };
  const expressionAttributeValues = {
    ":status": updates.status,
    ":endTime": endTime,
    ":duration": duration
  };
  if (updates.resourcesStarted !== void 0) {
    updateExpressions.push("resourcesStarted = :resourcesStarted");
    expressionAttributeValues[":resourcesStarted"] = updates.resourcesStarted;
  }
  if (updates.resourcesStopped !== void 0) {
    updateExpressions.push("resourcesStopped = :resourcesStopped");
    expressionAttributeValues[":resourcesStopped"] = updates.resourcesStopped;
  }
  if (updates.resourcesFailed !== void 0) {
    updateExpressions.push("resourcesFailed = :resourcesFailed");
    expressionAttributeValues[":resourcesFailed"] = updates.resourcesFailed;
  }
  if (updates.errorMessage) {
    updateExpressions.push("errorMessage = :errorMessage");
    expressionAttributeValues[":errorMessage"] = updates.errorMessage;
  }
  if (updates.details) {
    updateExpressions.push("details = :details");
    expressionAttributeValues[":details"] = updates.details;
  }
  if (updates.schedule_metadata) {
    updateExpressions.push("schedule_metadata = :schedule_metadata");
    expressionAttributeValues[":schedule_metadata"] = updates.schedule_metadata;
  }
  try {
    await client.send(new UpdateCommand({
      TableName: APP_TABLE_NAME,
      Key: {
        pk: buildExecutionPK(record.tenantId, record.scheduleId),
        sk: buildExecutionSK(record.startTime, record.executionId)
      },
      UpdateExpression: updateExpressions.join(", "),
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues
    }));
    logger.info(`Execution record updated: ${record.executionId}`, {
      status: updates.status,
      duration
    });
  } catch (error) {
    logger.error("Failed to update execution record", error);
    throw error;
  }
}
async function getExecutionHistory(scheduleId, tenantId = DEFAULT_TENANT_ID, limit = 50) {
  const client = getDynamoDBClient();
  try {
    const response = await client.send(new QueryCommand2({
      TableName: APP_TABLE_NAME,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :skPrefix)",
      ExpressionAttributeValues: {
        ":pk": buildExecutionPK(tenantId, scheduleId),
        ":skPrefix": "EXEC#"
      },
      ScanIndexForward: false,
      // newest first
      Limit: limit
    }));
    return response.Items || [];
  } catch (error) {
    logger.error("Failed to fetch execution history", error, { scheduleId });
    return [];
  }
}
async function getLastECSServiceState(scheduleId, serviceArn, tenantId = DEFAULT_TENANT_ID) {
  try {
    const executions = await getExecutionHistory(scheduleId, tenantId, 10);
    for (const execution of executions) {
      if (execution.schedule_metadata?.ecs) {
        const ecsResource = execution.schedule_metadata.ecs.find(
          (e) => e.arn === serviceArn && e.action === "stop" && e.status === "success"
        );
        if (ecsResource && ecsResource.last_state.desiredCount > 0) {
          logger.debug(`Found last ECS state for ${serviceArn}: desiredCount=${ecsResource.last_state.desiredCount}`);
          return { desiredCount: ecsResource.last_state.desiredCount };
        }
      }
    }
    logger.debug(`No previous ECS state found for ${serviceArn}`);
    return null;
  } catch (error) {
    logger.error(`Failed to get last ECS service state for ${serviceArn}`, error);
    return null;
  }
}
async function getLastEC2InstanceState(scheduleId, instanceArn, tenantId = DEFAULT_TENANT_ID) {
  try {
    const executions = await getExecutionHistory(scheduleId, tenantId, 10);
    for (const execution of executions) {
      if (execution.schedule_metadata?.ec2) {
        const ec2Resource = execution.schedule_metadata.ec2.find(
          (e) => e.arn === instanceArn && e.action === "stop" && e.status === "success"
        );
        if (ec2Resource) {
          logger.debug(`Found last EC2 state for ${instanceArn}: instanceState=${ec2Resource.last_state.instanceState}`);
          return {
            instanceState: ec2Resource.last_state.instanceState,
            instanceType: ec2Resource.last_state.instanceType
          };
        }
      }
    }
    logger.debug(`No previous EC2 state found for ${instanceArn}`);
    return null;
  } catch (error) {
    logger.error(`Failed to get last EC2 instance state for ${instanceArn}`, error);
    return null;
  }
}
async function getLastRDSInstanceState(scheduleId, instanceArn, tenantId = DEFAULT_TENANT_ID) {
  try {
    const executions = await getExecutionHistory(scheduleId, tenantId, 10);
    for (const execution of executions) {
      if (execution.schedule_metadata?.rds) {
        const rdsResource = execution.schedule_metadata.rds.find(
          (e) => e.arn === instanceArn && e.action === "stop" && e.status === "success"
        );
        if (rdsResource) {
          logger.debug(`Found last RDS state for ${instanceArn}: dbInstanceStatus=${rdsResource.last_state.dbInstanceStatus}`);
          return {
            dbInstanceStatus: rdsResource.last_state.dbInstanceStatus,
            dbInstanceClass: rdsResource.last_state.dbInstanceClass
          };
        }
      }
    }
    logger.debug(`No previous RDS state found for ${instanceArn}`);
    return null;
  } catch (error) {
    logger.error(`Failed to get last RDS instance state for ${instanceArn}`, error);
    return null;
  }
}

// src/services/sts-service.ts
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
var AWS_REGION2 = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "ap-south-1";
var stsClient = null;
function getSTSClient() {
  if (!stsClient) {
    stsClient = new STSClient({ region: AWS_REGION2 });
  }
  return stsClient;
}
async function assumeRole(roleArn, accountId, region, externalId) {
  const client = getSTSClient();
  const roleSessionName = `scheduler-session-${accountId}-${region}`;
  logger.debug(`Assuming role ${roleArn} for account ${accountId}`, { accountId, region });
  try {
    logger.info(`Attempting to assume role: ${roleArn}`, {
      accountId,
      region,
      roleSessionName,
      hasExternalId: !!externalId
    });
    const response = await client.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: roleSessionName,
      DurationSeconds: 3600,
      // 1 hour
      ExternalId: externalId
    }));
    if (!response.Credentials) {
      throw new Error("No credentials returned from AssumeRole");
    }
    return {
      credentials: {
        accessKeyId: response.Credentials.AccessKeyId,
        secretAccessKey: response.Credentials.SecretAccessKey,
        sessionToken: response.Credentials.SessionToken
      },
      region
    };
  } catch (error) {
    logger.error(`Failed to assume role ${roleArn}`, error, { accountId, region });
    throw error;
  }
}

// src/resource-schedulers/ec2-scheduler.ts
import {
  EC2Client,
  DescribeInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand
} from "@aws-sdk/client-ec2";
async function processEC2Resource(resource, schedule, action, credentials, metadata, lastState) {
  const ec2Client = new EC2Client({
    credentials: credentials.credentials,
    region: credentials.region
  });
  const log = logger.child({
    executionId: metadata.executionId,
    accountId: metadata.account.accountId,
    region: metadata.region,
    service: "ec2",
    resourceId: resource.id
  });
  log.info(`Processing EC2 resource: ${resource.id} (${resource.name || "unnamed"})`);
  try {
    const describeResponse = await ec2Client.send(new DescribeInstancesCommand({
      InstanceIds: [resource.id]
    }));
    const instance = describeResponse.Reservations?.[0]?.Instances?.[0];
    if (!instance) {
      throw new Error(`EC2 instance ${resource.id} not found`);
    }
    const currentState = instance.State?.Name || "unknown";
    const instanceType = instance.InstanceType || "unknown";
    log.debug(`EC2 ${resource.id}: currentState=${currentState}, desiredAction=${action}, lastState=${lastState?.instanceState || "none"}`);
    if (action === "start" && currentState !== "running" && currentState !== "pending") {
      if (lastState) {
        log.info(`EC2 ${resource.id}: Restoring from scheduler-managed state (was ${lastState.instanceState})`);
      }
      await ec2Client.send(new StartInstancesCommand({ InstanceIds: [resource.id] }));
      log.info(`Started EC2 instance ${resource.id}`);
      await createAuditLog({
        type: "audit_log",
        eventType: "scheduler.ec2.start",
        action: "start",
        user: "system",
        userType: "system",
        resourceType: "ec2",
        resourceId: resource.id,
        status: "success",
        details: `Started EC2 instance ${resource.id} (${resource.name}) for schedule ${schedule.name}`,
        severity: "medium",
        accountId: metadata.account.accountId,
        region: metadata.region
      });
      return {
        arn: resource.arn,
        resourceId: resource.id,
        action: "start",
        status: "success",
        last_state: {
          instanceState: currentState,
          instanceType
        }
      };
    } else if (action === "stop" && currentState === "running") {
      await ec2Client.send(new StopInstancesCommand({ InstanceIds: [resource.id] }));
      log.info(`Stopped EC2 instance ${resource.id} (saving state: instanceState=${currentState}, instanceType=${instanceType})`);
      await createAuditLog({
        type: "audit_log",
        eventType: "scheduler.ec2.stop",
        action: "stop",
        user: "system",
        userType: "system",
        resourceType: "ec2",
        resourceId: resource.id,
        status: "success",
        details: `Stopped EC2 instance ${resource.id} (${resource.name}) for schedule ${schedule.name}`,
        severity: "medium",
        accountId: metadata.account.accountId,
        region: metadata.region
      });
      return {
        arn: resource.arn,
        resourceId: resource.id,
        action: "stop",
        status: "success",
        last_state: {
          instanceState: currentState,
          instanceType
        }
      };
    } else {
      log.debug(`EC2 ${resource.id} already in desired state, skipping`);
      return {
        arn: resource.arn,
        resourceId: resource.id,
        action: "skip",
        status: "success",
        last_state: {
          instanceState: currentState,
          instanceType
        }
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`Failed to process EC2 instance ${resource.id}`, error);
    await createAuditLog({
      type: "audit_log",
      eventType: "scheduler.ec2.error",
      action,
      user: "system",
      userType: "system",
      resourceType: "ec2",
      resourceId: resource.id,
      status: "error",
      details: `Failed to ${action} EC2 instance ${resource.id}: ${errorMessage}`,
      severity: "high",
      accountId: metadata.account.accountId,
      region: metadata.region
    });
    return {
      arn: resource.arn,
      resourceId: resource.id,
      action,
      status: "failed",
      error: errorMessage,
      last_state: {
        instanceState: "unknown"
      }
    };
  }
}

// src/resource-schedulers/rds-scheduler.ts
import {
  RDSClient,
  DescribeDBInstancesCommand,
  StartDBInstanceCommand,
  StopDBInstanceCommand
} from "@aws-sdk/client-rds";
async function processRDSResource(resource, schedule, action, credentials, metadata, lastState) {
  const rdsClient = new RDSClient({
    credentials: credentials.credentials,
    region: credentials.region
  });
  const log = logger.child({
    executionId: metadata.executionId,
    accountId: metadata.account.accountId,
    region: metadata.region,
    service: "rds",
    resourceId: resource.id
  });
  log.info(`Processing RDS resource: ${resource.id} (${resource.name || "unnamed"})`);
  try {
    const describeResponse = await rdsClient.send(new DescribeDBInstancesCommand({
      DBInstanceIdentifier: resource.id
    }));
    const instance = describeResponse.DBInstances?.[0];
    if (!instance) {
      throw new Error(`RDS instance ${resource.id} not found`);
    }
    const currentStatus = instance.DBInstanceStatus || "unknown";
    const dbInstanceClass = instance.DBInstanceClass || "unknown";
    log.debug(`RDS ${resource.id}: currentStatus=${currentStatus}, desiredAction=${action}, lastState=${lastState?.dbInstanceStatus || "none"}`);
    if (action === "start" && currentStatus !== "available" && currentStatus !== "starting") {
      if (lastState) {
        log.info(`RDS ${resource.id}: Restoring from scheduler-managed state (was ${lastState.dbInstanceStatus})`);
      }
      await rdsClient.send(new StartDBInstanceCommand({ DBInstanceIdentifier: resource.id }));
      log.info(`Started RDS instance ${resource.id}`);
      await createAuditLog({
        type: "audit_log",
        eventType: "scheduler.rds.start",
        action: "start",
        user: "system",
        userType: "system",
        resourceType: "rds",
        resourceId: resource.id,
        status: "success",
        details: `Started RDS instance ${resource.id} (${resource.name}) for schedule ${schedule.name}`,
        severity: "medium",
        accountId: metadata.account.accountId,
        region: metadata.region
      });
      return {
        arn: resource.arn,
        resourceId: resource.id,
        action: "start",
        status: "success",
        last_state: {
          dbInstanceStatus: currentStatus,
          dbInstanceClass
        }
      };
    } else if (action === "stop" && currentStatus === "available") {
      await rdsClient.send(new StopDBInstanceCommand({ DBInstanceIdentifier: resource.id }));
      log.info(`Stopped RDS instance ${resource.id} (saving state: dbInstanceStatus=${currentStatus}, dbInstanceClass=${dbInstanceClass})`);
      await createAuditLog({
        type: "audit_log",
        eventType: "scheduler.rds.stop",
        action: "stop",
        user: "system",
        userType: "system",
        resourceType: "rds",
        resourceId: resource.id,
        status: "success",
        details: `Stopped RDS instance ${resource.id} (${resource.name}) for schedule ${schedule.name}`,
        severity: "medium",
        accountId: metadata.account.accountId,
        region: metadata.region
      });
      return {
        arn: resource.arn,
        resourceId: resource.id,
        action: "stop",
        status: "success",
        last_state: {
          dbInstanceStatus: currentStatus,
          dbInstanceClass
        }
      };
    } else {
      log.debug(`RDS ${resource.id} already in desired state, skipping`);
      return {
        arn: resource.arn,
        resourceId: resource.id,
        action: "skip",
        status: "success",
        last_state: {
          dbInstanceStatus: currentStatus,
          dbInstanceClass
        }
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`Failed to process RDS instance ${resource.id}`, error);
    await createAuditLog({
      type: "audit_log",
      eventType: "scheduler.rds.error",
      action,
      user: "system",
      userType: "system",
      resourceType: "rds",
      resourceId: resource.id,
      status: "error",
      details: `Failed to ${action} RDS instance ${resource.id}: ${errorMessage}`,
      severity: "high",
      accountId: metadata.account.accountId,
      region: metadata.region
    });
    return {
      arn: resource.arn,
      resourceId: resource.id,
      action,
      status: "failed",
      error: errorMessage,
      last_state: {
        dbInstanceStatus: "unknown"
      }
    };
  }
}

// src/resource-schedulers/ecs-scheduler.ts
import {
  ECSClient,
  DescribeServicesCommand,
  UpdateServiceCommand
} from "@aws-sdk/client-ecs";
async function processECSResource(resource, schedule, action, credentials, metadata, lastDesiredCount) {
  const ecsClient = new ECSClient({
    credentials: credentials.credentials,
    region: credentials.region
  });
  const log = logger.child({
    executionId: metadata.executionId,
    accountId: metadata.account.accountId,
    region: metadata.region,
    service: "ecs",
    resourceId: resource.id
  });
  let clusterArn = resource.clusterArn;
  if (!clusterArn) {
    const extractedCluster = extractClusterName(resource.arn);
    if (extractedCluster) {
      clusterArn = extractedCluster;
      log.debug(`Extracted cluster name '${clusterArn}' from service ARN`);
    }
  }
  if (!clusterArn) {
    const errorMessage = `ECS service ${resource.id} is missing clusterArn and it could not be extracted from ARN`;
    log.error(errorMessage);
    return {
      arn: resource.arn,
      resourceId: resource.id,
      clusterArn: "unknown",
      action,
      status: "failed",
      error: errorMessage,
      last_state: {
        desiredCount: 0,
        runningCount: 0
      }
    };
  }
  const serviceName = extractServiceName(resource.arn);
  log.info(`Processing ECS service: ${serviceName} (${resource.name || "unnamed"}) in cluster ${clusterArn}`);
  try {
    const describeResponse = await ecsClient.send(new DescribeServicesCommand({
      cluster: clusterArn,
      services: [serviceName]
    }));
    const service = describeResponse.services?.[0];
    if (!service) {
      throw new Error(`ECS service ${serviceName} not found in cluster ${clusterArn}`);
    }
    const currentDesiredCount = service.desiredCount ?? 0;
    const runningCount = service.runningCount ?? 0;
    const pendingCount = service.pendingCount ?? 0;
    const serviceStatus = service.status ?? "unknown";
    log.debug(`ECS ${serviceName}: desiredCount=${currentDesiredCount}, runningCount=${runningCount}, action=${action}`);
    if (action === "stop" && currentDesiredCount > 0) {
      await ecsClient.send(new UpdateServiceCommand({
        cluster: clusterArn,
        service: serviceName,
        desiredCount: 0
      }));
      log.info(`Stopped ECS service ${serviceName} (was desiredCount=${currentDesiredCount})`);
      await createAuditLog({
        type: "audit_log",
        eventType: "scheduler.ecs.stop",
        action: "stop",
        user: "system",
        userType: "system",
        resourceType: "ecs-service",
        resourceId: serviceName,
        status: "success",
        details: `Stopped ECS service ${serviceName} for schedule ${schedule.name}. Previous desiredCount: ${currentDesiredCount}`,
        severity: "medium",
        accountId: metadata.account.accountId,
        region: metadata.region
      });
      return {
        arn: resource.arn,
        resourceId: resource.id,
        clusterArn,
        action: "stop",
        status: "success",
        last_state: {
          desiredCount: currentDesiredCount,
          // Save this for restoration!
          runningCount,
          pendingCount,
          status: serviceStatus
        }
      };
    } else if (action === "start" && currentDesiredCount === 0) {
      const targetDesiredCount = lastDesiredCount && lastDesiredCount > 0 ? lastDesiredCount : 1;
      await ecsClient.send(new UpdateServiceCommand({
        cluster: clusterArn,
        service: serviceName,
        desiredCount: targetDesiredCount
      }));
      log.info(`Started ECS service ${serviceName} with desiredCount=${targetDesiredCount}`);
      await createAuditLog({
        type: "audit_log",
        eventType: "scheduler.ecs.start",
        action: "start",
        user: "system",
        userType: "system",
        resourceType: "ecs-service",
        resourceId: serviceName,
        status: "success",
        details: `Started ECS service ${serviceName} for schedule ${schedule.name}. Restored desiredCount: ${targetDesiredCount}`,
        severity: "medium",
        accountId: metadata.account.accountId,
        region: metadata.region
      });
      return {
        arn: resource.arn,
        resourceId: resource.id,
        clusterArn,
        action: "start",
        status: "success",
        last_state: {
          desiredCount: currentDesiredCount,
          // Was 0 before start
          runningCount,
          pendingCount,
          status: serviceStatus
        }
      };
    } else {
      log.debug(`ECS ${serviceName} already in desired state, skipping`);
      return {
        arn: resource.arn,
        resourceId: resource.id,
        clusterArn,
        action: "skip",
        status: "success",
        last_state: {
          desiredCount: currentDesiredCount,
          runningCount,
          pendingCount,
          status: serviceStatus
        }
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`Failed to process ECS service ${serviceName}`, error);
    await createAuditLog({
      type: "audit_log",
      eventType: "scheduler.ecs.error",
      action,
      user: "system",
      userType: "system",
      resourceType: "ecs-service",
      resourceId: serviceName,
      status: "error",
      details: `Failed to ${action} ECS service ${serviceName}: ${errorMessage}`,
      severity: "high",
      accountId: metadata.account.accountId,
      region: metadata.region
    });
    return {
      arn: resource.arn,
      resourceId: resource.id,
      clusterArn,
      action,
      status: "failed",
      error: errorMessage,
      last_state: {
        desiredCount: 0,
        runningCount: 0
      }
    };
  }
}
function extractServiceName(arn) {
  const match = arn.match(/service\/[^/]+\/(.+)$/);
  if (!match) {
    const altMatch = arn.match(/service\/(.+)$/);
    if (!altMatch) {
      throw new Error(`Invalid ECS service ARN format: ${arn}`);
    }
    return altMatch[1];
  }
  return match[1];
}
function extractClusterName(arn) {
  const match = arn.match(/service\/([^/]+)\/[^/]+$/);
  if (!match) {
    return null;
  }
  return match[1];
}

// src/services/scheduler-service.ts
async function runFullScan(triggeredBy = "system") {
  const executionId = v4_default();
  const startTime = Date.now();
  logger.setContext({ executionId, mode: "full" });
  logger.info("Starting full scan");
  const schedules = await fetchActiveSchedules();
  const accounts = await fetchActiveAccounts();
  logger.info(`Found ${schedules.length} active schedules and ${accounts.length} active accounts`);
  if (schedules.length === 0) {
    logger.info("No active schedules to process");
    return createResult(executionId, "full", startTime, 0, 0, 0, 0);
  }
  let totalStarted = 0;
  let totalStopped = 0;
  let totalFailed = 0;
  const processedSchedules = [];
  for (const schedule of schedules) {
    try {
      const result = await processSchedule(schedule, accounts, triggeredBy);
      totalStarted += result.started;
      totalStopped += result.stopped;
      totalFailed += result.failed;
      processedSchedules.push({
        scheduleId: schedule.scheduleId,
        scheduleName: schedule.name,
        started: result.started,
        stopped: result.stopped,
        failed: result.failed,
        status: result.failed > 0 ? "partial" : "success"
      });
    } catch (error) {
      logger.error(`Error processing schedule ${schedule.scheduleId}`, error);
      totalFailed++;
      processedSchedules.push({
        scheduleId: schedule.scheduleId,
        scheduleName: schedule.name,
        started: 0,
        stopped: 0,
        failed: 1,
        status: "error"
      });
    }
  }
  const overallStatus = totalFailed > 0 ? totalStarted + totalStopped > 0 ? "warning" : "error" : "success";
  await createAuditLog({
    type: "audit_log",
    eventType: "scheduler.complete",
    action: "full_scan",
    user: "system",
    userType: "system",
    resourceType: "scheduler",
    resourceId: executionId,
    status: overallStatus,
    details: `Full scan completed: ${totalStarted} started, ${totalStopped} stopped, ${totalFailed} failed`,
    severity: totalFailed > 0 ? "medium" : "info",
    metadata: {
      schedulesProcessed: schedules.length,
      resourcesStarted: totalStarted,
      resourcesStopped: totalStopped,
      resourcesFailed: totalFailed,
      scheduleDetails: processedSchedules
    }
  });
  logger.info("Full scan completed", { totalStarted, totalStopped, totalFailed });
  return createResult(
    executionId,
    "full",
    startTime,
    schedules.length,
    totalStarted,
    totalStopped,
    totalFailed
  );
}
async function runPartialScan(event, triggeredBy = "web-ui") {
  const executionId = v4_default();
  const startTime = Date.now();
  const scheduleId = event.scheduleId || event.scheduleName;
  const userEmail = event.userEmail;
  if (!scheduleId) {
    throw new Error("scheduleId or scheduleName is required for partial scan");
  }
  logger.setContext({ executionId, mode: "partial", scheduleId, user: userEmail || "system" });
  logger.info(`Starting partial scan for schedule: ${scheduleId}`);
  const schedule = await fetchScheduleById(scheduleId, event.tenantId);
  if (!schedule) {
    await createAuditLog({
      type: "audit_log",
      eventType: "scheduler.error",
      action: "partial_scan",
      user: userEmail || "system",
      userType: userEmail ? "user" : "system",
      resourceType: "scheduler",
      resourceId: scheduleId,
      status: "error",
      details: `Partial scan failed: Schedule not found: ${scheduleId}`,
      severity: "high",
      metadata: {
        scheduleId,
        triggeredBy
      }
    });
    throw new Error(`Schedule not found: ${scheduleId}`);
  }
  const accounts = await fetchActiveAccounts();
  try {
    const result = await processSchedule(schedule, accounts, triggeredBy, userEmail);
    const overallStatus = result.failed > 0 ? result.started + result.stopped > 0 ? "warning" : "error" : "success";
    await createAuditLog({
      type: "audit_log",
      eventType: "scheduler.complete",
      action: "partial_scan",
      user: userEmail || "system",
      userType: userEmail ? "user" : "system",
      resourceType: "scheduler",
      resourceId: executionId,
      resource: schedule.name,
      status: overallStatus,
      details: `Partial scan completed for "${schedule.name}": ${result.started} started, ${result.stopped} stopped, ${result.failed} failed`,
      severity: result.failed > 0 ? "medium" : "info",
      metadata: {
        scheduleId: schedule.scheduleId,
        scheduleName: schedule.name,
        resourcesStarted: result.started,
        resourcesStopped: result.stopped,
        resourcesFailed: result.failed,
        triggeredBy
      }
    });
    logger.info("Partial scan completed", result);
    return createResult(
      executionId,
      "partial",
      startTime,
      1,
      result.started,
      result.stopped,
      result.failed
    );
  } catch (error) {
    await createAuditLog({
      type: "audit_log",
      eventType: "scheduler.error",
      action: "partial_scan",
      user: userEmail || "system",
      userType: userEmail ? "user" : "system",
      resourceType: "scheduler",
      resourceId: executionId,
      resource: schedule.name,
      status: "error",
      details: `Partial scan failed for "${schedule.name}": ${error instanceof Error ? error.message : String(error)}`,
      severity: "high",
      metadata: {
        scheduleId: schedule.scheduleId,
        scheduleName: schedule.name,
        triggeredBy,
        error: error instanceof Error ? error.message : String(error)
      }
    });
    logger.error(`Partial scan failed for schedule ${scheduleId}`, error);
    throw error;
  }
}
async function processSchedule(schedule, accounts, triggeredBy, userEmail) {
  const resources = schedule.resources || [];
  const scheduleStartTime = Date.now();
  logger.info(`Processing schedule: ${schedule.name} (${schedule.scheduleId}) with ${resources.length} resources`);
  if (resources.length === 0) {
    logger.info(`Schedule ${schedule.name} has no resources, skipping`);
    return { started: 0, stopped: 0, failed: 0 };
  }
  const inRange = isCurrentTimeInRange(
    schedule.starttime,
    schedule.endtime,
    schedule.timezone,
    schedule.days
  );
  const action = inRange ? "start" : "stop";
  logger.info(`Schedule ${schedule.name}: inRange=${inRange}, action=${action}`);
  const execParams = {
    scheduleId: schedule.scheduleId,
    scheduleName: schedule.name,
    tenantId: schedule.tenantId || DEFAULT_TENANT_ID,
    accountId: schedule.accountId || "system",
    triggeredBy
  };
  const executionId = v4_default();
  const resourcesByAccount = groupResourcesByAccount(resources, accounts);
  const scheduleMetadata = {
    ec2: [],
    ecs: [],
    rds: []
  };
  let started = 0;
  let stopped = 0;
  let failed = 0;
  for (const [accountId, accountResources] of resourcesByAccount) {
    const account = accounts.find((a) => a.accountId === accountId);
    if (!account) {
      logger.warn(`Account ${accountId} not found in active accounts, skipping resources`);
      failed += accountResources.resources.length;
      continue;
    }
    const resourcesByRegion = groupResourcesByRegion(accountResources.resources);
    for (const [region, regionResources] of resourcesByRegion) {
      try {
        const credentials = await assumeRole(account.roleArn, account.accountId, region, account.externalId);
        const metadata = {
          account: {
            name: account.accountName || account.name || account.accountId,
            accountId: account.accountId
          },
          region,
          executionId,
          scheduleId: schedule.scheduleId,
          scheduleName: schedule.name
        };
        for (const resource of regionResources) {
          try {
            if (resource.type === "ec2") {
              let lastState;
              if (action === "start") {
                const savedState = await getLastEC2InstanceState(
                  schedule.scheduleId,
                  resource.arn,
                  schedule.tenantId
                );
                lastState = savedState || void 0;
                if (lastState) {
                  logger.debug(`EC2 ${resource.id}: Found last state - instanceState=${lastState.instanceState}`);
                }
              }
              const result = await processEC2Resource(resource, schedule, action, credentials, metadata, lastState);
              scheduleMetadata.ec2.push(result);
              updateCounts(result, action, { started: () => started++, stopped: () => stopped++, failed: () => failed++ });
            } else if (resource.type === "rds") {
              let lastState;
              if (action === "start") {
                const savedState = await getLastRDSInstanceState(
                  schedule.scheduleId,
                  resource.arn,
                  schedule.tenantId
                );
                lastState = savedState || void 0;
                if (lastState) {
                  logger.debug(`RDS ${resource.id}: Found last state - dbInstanceStatus=${lastState.dbInstanceStatus}`);
                }
              }
              const result = await processRDSResource(resource, schedule, action, credentials, metadata, lastState);
              scheduleMetadata.rds.push(result);
              updateCounts(result, action, { started: () => started++, stopped: () => stopped++, failed: () => failed++ });
            } else if (resource.type === "ecs") {
              let lastDesiredCount;
              if (action === "start") {
                const lastState = await getLastECSServiceState(
                  schedule.scheduleId,
                  resource.arn,
                  schedule.tenantId
                );
                lastDesiredCount = lastState?.desiredCount;
              }
              const result = await processECSResource(resource, schedule, action, credentials, metadata, lastDesiredCount);
              scheduleMetadata.ecs.push(result);
              updateCounts(result, action, { started: () => started++, stopped: () => stopped++, failed: () => failed++ });
            }
          } catch (error) {
            logger.error(`Error processing resource ${resource.arn}`, error);
            failed++;
          }
        }
      } catch (error) {
        logger.error(`Failed to assume role for account ${accountId} in region ${region}`, error);
        failed += regionResources.length;
      }
    }
  }
  const hasActions = started > 0 || stopped > 0 || failed > 0;
  if (hasActions) {
    const execRecord = await createExecutionRecord(execParams);
    const duration = Date.now() - scheduleStartTime;
    await updateExecutionRecord(execRecord, {
      status: failed > 0 ? "partial" : "success",
      resourcesStarted: started,
      resourcesStopped: stopped,
      resourcesFailed: failed,
      schedule_metadata: scheduleMetadata
    });
    await createExecutionAuditLog(execRecord.executionId, schedule, scheduleMetadata, {
      resourcesStarted: started,
      resourcesStopped: stopped,
      resourcesFailed: failed,
      duration
    }, userEmail);
    logger.info(`Schedule ${schedule.name} execution recorded: ${started} started, ${stopped} stopped, ${failed} failed`);
  } else {
    logger.info(`Schedule ${schedule.name}: No actions performed (all resources in desired state), skipping execution record`);
  }
  return { started, stopped, failed };
}
function groupResourcesByAccount(resources, _accounts) {
  const map = /* @__PURE__ */ new Map();
  for (const resource of resources || []) {
    const accountId = extractAccountIdFromArn(resource.arn);
    if (!accountId) {
      logger.warn(`Could not extract account ID from ARN: ${resource.arn}`);
      continue;
    }
    if (!map.has(accountId)) {
      map.set(accountId, { resources: [] });
    }
    map.get(accountId).resources.push(resource);
  }
  return map;
}
function groupResourcesByRegion(resources) {
  const map = /* @__PURE__ */ new Map();
  for (const resource of resources) {
    const region = extractRegionFromArn4(resource.arn);
    if (!region) {
      logger.warn(`Could not extract region from ARN: ${resource.arn}`);
      continue;
    }
    if (!map.has(region)) {
      map.set(region, []);
    }
    map.get(region).push(resource);
  }
  return map;
}
function extractAccountIdFromArn(arn) {
  const parts = arn.split(":");
  if (parts.length < 5) {
    return null;
  }
  return parts[4];
}
function extractRegionFromArn4(arn) {
  const parts = arn.split(":");
  if (parts.length < 4) {
    return null;
  }
  return parts[3];
}
function updateCounts(result, _action, counters) {
  if (result.status === "failed") {
    counters.failed();
  } else if (result.action === "start") {
    counters.started();
  } else if (result.action === "stop") {
    counters.stopped();
  }
}
function createResult(executionId, mode, startTime, schedulesProcessed, resourcesStarted, resourcesStopped, resourcesFailed) {
  return {
    success: resourcesFailed === 0,
    executionId,
    mode,
    schedulesProcessed,
    resourcesStarted,
    resourcesStopped,
    resourcesFailed,
    duration: Date.now() - startTime
  };
}

// src/index.ts
var handler = async (event) => {
  logger.info("Lambda invoked", { event });
  try {
    const isPartialScan = event?.scheduleId || event?.scheduleName;
    const triggeredBy = event?.triggeredBy || "system";
    if (isPartialScan) {
      logger.info("Running partial scan", {
        scheduleId: event.scheduleId,
        scheduleName: event.scheduleName
      });
      return await runPartialScan(event, triggeredBy);
    } else {
      logger.info("Running full scan");
      return await runFullScan(triggeredBy);
    }
  } catch (error) {
    logger.error("Lambda execution failed", error);
    return {
      success: false,
      executionId: "error",
      mode: event?.scheduleId ? "partial" : "full",
      schedulesProcessed: 0,
      resourcesStarted: 0,
      resourcesStopped: 0,
      resourcesFailed: 0,
      duration: 0,
      errors: [error instanceof Error ? error.message : String(error)]
    };
  }
};
var index_default = handler;
export {
  index_default as default,
  handler
};
