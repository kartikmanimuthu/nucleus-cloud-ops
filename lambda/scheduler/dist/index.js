"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// node_modules/dayjs/dayjs.min.js
var require_dayjs_min = __commonJS({
  "node_modules/dayjs/dayjs.min.js"(exports2, module2) {
    !function(t, e) {
      "object" == typeof exports2 && "undefined" != typeof module2 ? module2.exports = e() : "function" == typeof define && define.amd ? define(e) : (t = "undefined" != typeof globalThis ? globalThis : t || self).dayjs = e();
    }(exports2, function() {
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
  "node_modules/dayjs/plugin/utc.js"(exports2, module2) {
    !function(t, i) {
      "object" == typeof exports2 && "undefined" != typeof module2 ? module2.exports = i() : "function" == typeof define && define.amd ? define(i) : (t = "undefined" != typeof globalThis ? globalThis : t || self).dayjs_plugin_utc = i();
    }(exports2, function() {
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
  "node_modules/dayjs/plugin/timezone.js"(exports2, module2) {
    !function(t, e) {
      "object" == typeof exports2 && "undefined" != typeof module2 ? module2.exports = e() : "function" == typeof define && define.amd ? define(e) : (t = "undefined" != typeof globalThis ? globalThis : t || self).dayjs_plugin_timezone = e();
    }(exports2, function() {
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

// src/index.ts
var index_exports = {};
__export(index_exports, {
  default: () => index_default,
  handler: () => handler
});
module.exports = __toCommonJS(index_exports);

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
var import_client_dynamodb = require("@aws-sdk/client-dynamodb");
var import_lib_dynamodb = require("@aws-sdk/lib-dynamodb");

// node_modules/uuid/dist/esm/stringify.js
var byteToHex = [];
for (let i = 0; i < 256; ++i) {
  byteToHex.push((i + 256).toString(16).slice(1));
}
function unsafeStringify(arr, offset = 0) {
  return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}

// node_modules/uuid/dist/esm/rng.js
var import_crypto = require("crypto");
var rnds8Pool = new Uint8Array(256);
var poolPtr = rnds8Pool.length;
function rng() {
  if (poolPtr > rnds8Pool.length - 16) {
    (0, import_crypto.randomFillSync)(rnds8Pool);
    poolPtr = 0;
  }
  return rnds8Pool.slice(poolPtr, poolPtr += 16);
}

// node_modules/uuid/dist/esm/native.js
var import_crypto2 = require("crypto");
var native_default = { randomUUID: import_crypto2.randomUUID };

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
var docClient = null;
function getDynamoDBClient() {
  if (!docClient) {
    const client = new import_client_dynamodb.DynamoDBClient({ region: AWS_REGION });
    docClient = import_lib_dynamodb.DynamoDBDocumentClient.from(client, {
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
    const response = await client.send(new import_lib_dynamodb.QueryCommand(params));
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
      const fallbackResponse = await client.send(new import_lib_dynamodb.QueryCommand(fallbackParams));
      logger.warn("Fallback: Fetched schedules via GSI1");
      return fallbackResponse.Items || [];
    } catch (fallbackError) {
      logger.error("Fallback fetch also failed", fallbackError);
      return [];
    }
  }
}
async function fetchScheduleById(scheduleId, tenantId = "default") {
  const client = getDynamoDBClient();
  const statuses = ["active", "inactive"];
  for (const status of statuses) {
    try {
      const response = await client.send(new import_lib_dynamodb.QueryCommand({
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
      logger.error(`Error searching GSI3 for status: ${status}`, error, { scheduleId });
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
    const response = await client.send(new import_lib_dynamodb.QueryCommand(params));
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
      const response = await client.send(new import_lib_dynamodb.QueryCommand(fallbackParams));
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
    await client.send(new import_lib_dynamodb.PutCommand({
      TableName: AUDIT_TABLE_NAME,
      Item: item
    }));
    logger.debug("Audit log created", { id, eventType: entry.eventType });
  } catch (error) {
    logger.error("Failed to create audit log", error);
  }
}

// src/services/execution-history-service.ts
var import_lib_dynamodb2 = require("@aws-sdk/lib-dynamodb");
var EXECUTION_TTL_DAYS = 30;
var buildExecutionPK = (tenantId, scheduleId) => `TENANT#${tenantId}#SCHEDULE#${scheduleId}`;
var buildExecutionSK = (timestamp, executionId) => `EXEC#${timestamp}#${executionId}`;
async function createExecutionRecord(params) {
  const client = getDynamoDBClient();
  const executionId = v4_default();
  const startTime = (/* @__PURE__ */ new Date()).toISOString();
  const tenantId = params.tenantId || "default";
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
    await client.send(new import_lib_dynamodb2.PutCommand({
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
    "duration = :duration"
  ];
  const expressionAttributeNames = {
    "#status": "status"
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
  try {
    await client.send(new import_lib_dynamodb2.UpdateCommand({
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

// src/services/sts-service.ts
var import_client_sts = require("@aws-sdk/client-sts");
var AWS_REGION2 = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "ap-south-1";
var stsClient = null;
function getSTSClient() {
  if (!stsClient) {
    stsClient = new import_client_sts.STSClient({ region: AWS_REGION2 });
  }
  return stsClient;
}
async function assumeRole(roleArn, accountId, region) {
  const client = getSTSClient();
  const roleSessionName = `scheduler-session-${accountId}-${region}`;
  logger.debug(`Assuming role ${roleArn} for account ${accountId}`, { accountId, region });
  try {
    const response = await client.send(new import_client_sts.AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: roleSessionName,
      DurationSeconds: 3600
      // 1 hour
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
var import_client_ec2 = require("@aws-sdk/client-ec2");
var SCHEDULE_TAG = process.env.SCHEDULER_TAG || "schedule";
async function processEC2Instances(schedules, credentials, metadata) {
  const results = [];
  const ec2Client = new import_client_ec2.EC2Client({
    credentials: credentials.credentials,
    region: credentials.region
  });
  const log = logger.child({
    executionId: metadata.executionId,
    accountId: metadata.account.accountId,
    region: metadata.region,
    service: "ec2"
  });
  log.info(`EC2 Scheduler started for ${metadata.account.name}`);
  try {
    const response = await ec2Client.send(new import_client_ec2.DescribeInstancesCommand({}));
    const instances = response.Reservations?.flatMap((r) => r.Instances || []) || [];
    const scheduledInstances = instances.filter((instance) => {
      const hasScheduleTag = instance.Tags?.some((tag) => tag.Key === SCHEDULE_TAG);
      const isECSManaged = instance.Tags?.some(
        (tag) => tag.Key === "AmazonECSManaged" && tag.Value === "true"
      );
      return hasScheduleTag && !isECSManaged;
    });
    log.debug(`Found ${scheduledInstances.length} scheduled EC2 instances`);
    for (const instance of scheduledInstances) {
      const result = await processInstance(instance, schedules, ec2Client, log, metadata);
      if (result) {
        results.push(result);
      }
    }
    log.info(`EC2 Scheduler completed - ${results.length} actions taken`);
  } catch (error) {
    log.error("EC2 Scheduler error", error);
    await createAuditLog({
      type: "audit_log",
      eventType: "scheduler.ec2.error",
      action: "scan",
      user: "system",
      userType: "system",
      resourceType: "ec2",
      resourceId: metadata.account.accountId,
      status: "error",
      details: `EC2 Scheduler error: ${error instanceof Error ? error.message : String(error)}`,
      severity: "high",
      accountId: metadata.account.accountId,
      region: metadata.region
    });
  }
  return results;
}
async function processInstance(instance, schedules, ec2Client, log, metadata) {
  const instanceId = instance.InstanceId;
  const scheduleTagValue = instance.Tags?.find((t) => t.Key === SCHEDULE_TAG)?.Value;
  if (!scheduleTagValue) return null;
  const schedule = schedules.find((s) => s.name === scheduleTagValue);
  if (!schedule) {
    log.debug(`Schedule "${scheduleTagValue}" not found for instance ${instanceId}`);
    return null;
  }
  const inRange = isCurrentTimeInRange(
    schedule.starttime,
    schedule.endtime,
    schedule.timezone,
    schedule.days
  );
  const currentState = instance.State?.Name;
  log.debug(`Processing EC2 ${instanceId}: schedule=${scheduleTagValue}, inRange=${inRange}, state=${currentState}`);
  try {
    if (inRange && currentState !== "running") {
      await ec2Client.send(new import_client_ec2.StartInstancesCommand({ InstanceIds: [instanceId] }));
      log.info(`Started EC2 instance ${instanceId}`);
      await createAuditLog({
        type: "audit_log",
        eventType: "scheduler.ec2.start",
        action: "start",
        user: "system",
        userType: "system",
        resourceType: "ec2",
        resourceId: instanceId,
        status: "success",
        details: `Started EC2 instance ${instanceId}`,
        severity: "medium",
        accountId: metadata.account.accountId,
        region: metadata.region
      });
      return { resourceId: instanceId, resourceType: "ec2", action: "start", success: true };
    } else if (!inRange && currentState === "running") {
      await ec2Client.send(new import_client_ec2.StopInstancesCommand({ InstanceIds: [instanceId] }));
      log.info(`Stopped EC2 instance ${instanceId}`);
      await createAuditLog({
        type: "audit_log",
        eventType: "scheduler.ec2.stop",
        action: "stop",
        user: "system",
        userType: "system",
        resourceType: "ec2",
        resourceId: instanceId,
        status: "success",
        details: `Stopped EC2 instance ${instanceId}`,
        severity: "medium",
        accountId: metadata.account.accountId,
        region: metadata.region
      });
      return { resourceId: instanceId, resourceType: "ec2", action: "stop", success: true };
    } else {
      log.debug(`EC2 ${instanceId} already in desired state`);
      return { resourceId: instanceId, resourceType: "ec2", action: "skip", success: true };
    }
  } catch (error) {
    log.error(`Failed to process EC2 instance ${instanceId}`, error);
    return {
      resourceId: instanceId,
      resourceType: "ec2",
      action: inRange ? "start" : "stop",
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// src/resource-schedulers/rds-scheduler.ts
var import_client_rds = require("@aws-sdk/client-rds");
var SCHEDULE_TAG2 = process.env.SCHEDULER_TAG || "schedule";
async function processRDSInstances(schedules, credentials, metadata) {
  const results = [];
  const rdsClient = new import_client_rds.RDSClient({
    credentials: credentials.credentials,
    region: credentials.region
  });
  const log = logger.child({
    executionId: metadata.executionId,
    accountId: metadata.account.accountId,
    region: metadata.region,
    service: "rds"
  });
  log.info(`RDS Scheduler started for ${metadata.account.name}`);
  try {
    const response = await rdsClient.send(new import_client_rds.DescribeDBInstancesCommand({}));
    const instances = response.DBInstances || [];
    log.debug(`Found ${instances.length} RDS instances`);
    for (const instance of instances) {
      const result = await processInstance2(instance, schedules, rdsClient, log, metadata);
      if (result) {
        results.push(result);
      }
    }
    log.info(`RDS Scheduler completed - ${results.length} actions taken`);
  } catch (error) {
    log.error("RDS Scheduler error", error);
    await createAuditLog({
      type: "audit_log",
      eventType: "scheduler.rds.error",
      action: "scan",
      user: "system",
      userType: "system",
      resourceType: "rds",
      resourceId: metadata.account.accountId,
      status: "error",
      details: `RDS Scheduler error: ${error instanceof Error ? error.message : String(error)}`,
      severity: "high",
      accountId: metadata.account.accountId,
      region: metadata.region
    });
  }
  return results;
}
async function processInstance2(instance, schedules, rdsClient, log, metadata) {
  const instanceId = instance.DBInstanceIdentifier;
  const instanceArn = instance.DBInstanceArn;
  try {
    const tagsResponse = await rdsClient.send(new import_client_rds.ListTagsForResourceCommand({
      ResourceName: instanceArn
    }));
    const scheduleTagValue = tagsResponse.TagList?.find((t) => t.Key === SCHEDULE_TAG2)?.Value;
    if (!scheduleTagValue) return null;
    const schedule = schedules.find((s) => s.name === scheduleTagValue);
    if (!schedule) {
      log.debug(`Schedule "${scheduleTagValue}" not found for RDS ${instanceId}`);
      return null;
    }
    const inRange = isCurrentTimeInRange(
      schedule.starttime,
      schedule.endtime,
      schedule.timezone,
      schedule.days
    );
    const currentStatus = instance.DBInstanceStatus;
    log.debug(`Processing RDS ${instanceId}: schedule=${scheduleTagValue}, inRange=${inRange}, status=${currentStatus}`);
    if (inRange && currentStatus !== "available" && currentStatus !== "starting") {
      await rdsClient.send(new import_client_rds.StartDBInstanceCommand({ DBInstanceIdentifier: instanceId }));
      log.info(`Started RDS instance ${instanceId}`);
      await createAuditLog({
        type: "audit_log",
        eventType: "scheduler.rds.start",
        action: "start",
        user: "system",
        userType: "system",
        resourceType: "rds",
        resourceId: instanceId,
        status: "success",
        details: `Started RDS instance ${instanceId}`,
        severity: "medium",
        accountId: metadata.account.accountId,
        region: metadata.region
      });
      return { resourceId: instanceId, resourceType: "rds", action: "start", success: true };
    } else if (!inRange && currentStatus === "available") {
      await rdsClient.send(new import_client_rds.StopDBInstanceCommand({ DBInstanceIdentifier: instanceId }));
      log.info(`Stopped RDS instance ${instanceId}`);
      await createAuditLog({
        type: "audit_log",
        eventType: "scheduler.rds.stop",
        action: "stop",
        user: "system",
        userType: "system",
        resourceType: "rds",
        resourceId: instanceId,
        status: "success",
        details: `Stopped RDS instance ${instanceId}`,
        severity: "medium",
        accountId: metadata.account.accountId,
        region: metadata.region
      });
      return { resourceId: instanceId, resourceType: "rds", action: "stop", success: true };
    } else {
      log.debug(`RDS ${instanceId} already in desired state`);
      return { resourceId: instanceId, resourceType: "rds", action: "skip", success: true };
    }
  } catch (error) {
    log.error(`Failed to process RDS instance ${instanceId}`, error);
    return {
      resourceId: instanceId,
      resourceType: "rds",
      action: "stop",
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// src/resource-schedulers/ecs-scheduler.ts
var import_client_ecs = require("@aws-sdk/client-ecs");
var import_client_auto_scaling = require("@aws-sdk/client-auto-scaling");
var SCHEDULE_TAG3 = process.env.SCHEDULER_TAG || "schedule";
async function processECSResources(schedules, credentials, metadata) {
  const results = [];
  const ecsClient = new import_client_ecs.ECSClient({
    credentials: credentials.credentials,
    region: credentials.region
  });
  const asgClient = new import_client_auto_scaling.AutoScalingClient({
    credentials: credentials.credentials,
    region: credentials.region
  });
  const log = logger.child({
    executionId: metadata.executionId,
    accountId: metadata.account.accountId,
    region: metadata.region,
    service: "ecs"
  });
  log.info(`ECS Scheduler started for ${metadata.account.name}`);
  try {
    const clustersResponse = await ecsClient.send(new import_client_ecs.ListClustersCommand({}));
    const clusterArns = clustersResponse.clusterArns || [];
    log.debug(`Found ${clusterArns.length} ECS clusters`);
    for (const clusterArn of clusterArns) {
      const clusterResults = await processCluster(
        clusterArn,
        schedules,
        ecsClient,
        asgClient,
        log,
        metadata
      );
      results.push(...clusterResults);
    }
    log.info(`ECS Scheduler completed - ${results.length} actions taken`);
  } catch (error) {
    log.error("ECS Scheduler error", error);
    await createAuditLog({
      type: "audit_log",
      eventType: "scheduler.ecs.error",
      action: "scan",
      user: "system",
      userType: "system",
      resourceType: "ecs",
      resourceId: metadata.account.accountId,
      status: "error",
      details: `ECS Scheduler error: ${error instanceof Error ? error.message : String(error)}`,
      severity: "high",
      accountId: metadata.account.accountId,
      region: metadata.region
    });
  }
  return results;
}
async function processCluster(clusterArn, schedules, ecsClient, asgClient, log, metadata) {
  const results = [];
  try {
    const tagsResponse = await ecsClient.send(new import_client_ecs.ListTagsForResourceCommand({
      resourceArn: clusterArn
    }));
    const tags = tagsResponse.tags || [];
    const scheduleTagValue = tags.find((t) => t.key === SCHEDULE_TAG3)?.value;
    if (!scheduleTagValue) {
      log.debug(`Cluster ${clusterArn} has no schedule tag, skipping`);
      return results;
    }
    const schedule = schedules.find((s) => s.name === scheduleTagValue);
    if (!schedule) {
      log.debug(`Schedule "${scheduleTagValue}" not found for cluster ${clusterArn}`);
      return results;
    }
    const inRange = isCurrentTimeInRange(
      schedule.starttime,
      schedule.endtime,
      schedule.timezone,
      schedule.days
    );
    const desiredCapacity = inRange ? 1 : 0;
    const servicesResults = await processClusterServices(
      clusterArn,
      schedules,
      ecsClient,
      log,
      metadata
    );
    results.push(...servicesResults);
    const asgResults = await processClusterASGs(
      clusterArn,
      desiredCapacity,
      ecsClient,
      asgClient,
      log,
      metadata
    );
    results.push(...asgResults);
  } catch (error) {
    log.error(`Error processing cluster ${clusterArn}`, error);
  }
  return results;
}
async function processClusterServices(clusterArn, schedules, ecsClient, log, metadata) {
  const results = [];
  try {
    const servicesResponse = await ecsClient.send(new import_client_ecs.ListServicesCommand({
      cluster: clusterArn
    }));
    const serviceArns = servicesResponse.serviceArns || [];
    for (const serviceArn of serviceArns) {
      const result = await processService(
        clusterArn,
        serviceArn,
        schedules,
        ecsClient,
        log,
        metadata
      );
      if (result) {
        results.push(result);
      }
    }
  } catch (error) {
    log.error(`Error processing services for cluster ${clusterArn}`, error);
  }
  return results;
}
async function processService(clusterArn, serviceArn, schedules, ecsClient, log, metadata) {
  try {
    const tagsResponse = await ecsClient.send(new import_client_ecs.ListTagsForResourceCommand({
      resourceArn: serviceArn
    }));
    const scheduleTagValue = tagsResponse.tags?.find((t) => t.key === SCHEDULE_TAG3)?.value;
    if (!scheduleTagValue) return null;
    const schedule = schedules.find((s) => s.name === scheduleTagValue);
    if (!schedule) return null;
    const serviceName = serviceArn.split("/").pop();
    const serviceDetails = await ecsClient.send(new import_client_ecs.DescribeServicesCommand({
      cluster: clusterArn,
      services: [serviceName]
    }));
    const service = serviceDetails.services?.[0];
    if (!service) return null;
    const inRange = isCurrentTimeInRange(
      schedule.starttime,
      schedule.endtime,
      schedule.timezone,
      schedule.days
    );
    const desiredCount = inRange ? 1 : 0;
    if (service.desiredCount === desiredCount) {
      log.debug(`ECS service ${serviceName} already at desired count ${desiredCount}`);
      return { resourceId: serviceName, resourceType: "ecs", action: "skip", success: true };
    }
    await ecsClient.send(new import_client_ecs.UpdateServiceCommand({
      cluster: clusterArn,
      service: serviceName,
      desiredCount
    }));
    log.info(`Updated ECS service ${serviceName} to count ${desiredCount}`);
    await createAuditLog({
      type: "audit_log",
      eventType: "scheduler.ecs.service.update",
      action: desiredCount > 0 ? "start" : "stop",
      user: "system",
      userType: "system",
      resourceType: "ecs-service",
      resourceId: serviceName,
      status: "success",
      details: `Updated ECS service ${serviceName} to count ${desiredCount}`,
      severity: "medium",
      accountId: metadata.account.accountId,
      region: metadata.region
    });
    return {
      resourceId: serviceName,
      resourceType: "ecs",
      action: desiredCount > 0 ? "start" : "stop",
      success: true
    };
  } catch (error) {
    const serviceName = serviceArn.split("/").pop();
    log.error(`Error processing ECS service ${serviceName}`, error);
    return {
      resourceId: serviceName,
      resourceType: "ecs",
      action: "stop",
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
async function processClusterASGs(clusterArn, desiredCapacity, ecsClient, asgClient, log, metadata) {
  const results = [];
  try {
    const clusterDetails = await ecsClient.send(new import_client_ecs.DescribeClustersCommand({
      clusters: [clusterArn]
    }));
    const cluster = clusterDetails.clusters?.[0];
    const capacityProviders = cluster?.capacityProviders || [];
    if (capacityProviders.length === 0) return results;
    const cpDetails = await ecsClient.send(new import_client_ecs.DescribeCapacityProvidersCommand({
      capacityProviders
    }));
    for (const cp of cpDetails.capacityProviders || []) {
      const asgArn = cp.autoScalingGroupProvider?.autoScalingGroupArn;
      if (!asgArn) continue;
      const asgName = asgArn.split("/").pop();
      const result = await updateASG(asgName, desiredCapacity, asgClient, log, metadata);
      if (result) {
        results.push(result);
      }
    }
  } catch (error) {
    log.error(`Error processing ASGs for cluster ${clusterArn}`, error);
  }
  return results;
}
async function updateASG(asgName, desiredCapacity, asgClient, log, metadata) {
  try {
    const asgResponse = await asgClient.send(new import_client_auto_scaling.DescribeAutoScalingGroupsCommand({
      AutoScalingGroupNames: [asgName]
    }));
    const asg = asgResponse.AutoScalingGroups?.[0];
    if (!asg || asg.DesiredCapacity === desiredCapacity) {
      return { resourceId: asgName, resourceType: "asg", action: "skip", success: true };
    }
    await asgClient.send(new import_client_auto_scaling.UpdateAutoScalingGroupCommand({
      AutoScalingGroupName: asgName,
      DesiredCapacity: desiredCapacity,
      MinSize: desiredCapacity
    }));
    log.info(`Updated ASG ${asgName} to capacity ${desiredCapacity}`);
    await createAuditLog({
      type: "audit_log",
      eventType: "scheduler.asg.update",
      action: desiredCapacity > 0 ? "start" : "stop",
      user: "system",
      userType: "system",
      resourceType: "asg",
      resourceId: asgName,
      status: "success",
      details: `Updated ASG ${asgName} to capacity ${desiredCapacity}`,
      severity: "medium",
      accountId: metadata.account.accountId,
      region: metadata.region
    });
    return {
      resourceId: asgName,
      resourceType: "asg",
      action: desiredCapacity > 0 ? "start" : "stop",
      success: true
    };
  } catch (error) {
    log.error(`Error updating ASG ${asgName}`, error);
    return {
      resourceId: asgName,
      resourceType: "asg",
      action: "stop",
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// src/services/scheduler-service.ts
async function runFullScan(triggeredBy = "system") {
  const executionId = v4_default();
  const startTime = Date.now();
  logger.setContext({ executionId, mode: "full" });
  logger.info("Starting full scan");
  await createAuditLog({
    type: "audit_log",
    eventType: "scheduler.start",
    action: "full_scan",
    user: "system",
    userType: "system",
    resourceType: "scheduler",
    resourceId: executionId,
    status: "info",
    details: `Full scheduler scan started: ${executionId}`,
    severity: "info"
  });
  const schedules = await fetchActiveSchedules();
  const accounts = await fetchActiveAccounts();
  logger.info(`Found ${schedules.length} schedules and ${accounts.length} accounts`);
  if (schedules.length === 0 || accounts.length === 0) {
    logger.info("No schedules or accounts to process");
    return createResult(executionId, "full", startTime, 0, 0, 0, 0);
  }
  const allResults = [];
  const accountPromises = accounts.map(
    (account) => processAccount(account, schedules, executionId, triggeredBy)
  );
  const accountResults = await Promise.allSettled(accountPromises);
  for (const result of accountResults) {
    if (result.status === "fulfilled") {
      allResults.push(...result.value);
    }
  }
  const summary = summarizeResults(allResults);
  await createAuditLog({
    type: "audit_log",
    eventType: "scheduler.complete",
    action: "full_scan",
    user: "system",
    userType: "system",
    resourceType: "scheduler",
    resourceId: executionId,
    status: "success",
    details: `Full scan completed: ${summary.started} started, ${summary.stopped} stopped, ${summary.failed} failed`,
    severity: "info"
  });
  logger.info("Full scan completed", summary);
  return createResult(
    executionId,
    "full",
    startTime,
    schedules.length,
    summary.started,
    summary.stopped,
    summary.failed
  );
}
async function runPartialScan(event, triggeredBy = "web-ui") {
  const executionId = v4_default();
  const startTime = Date.now();
  const scheduleId = event.scheduleId || event.scheduleName;
  if (!scheduleId) {
    throw new Error("scheduleId or scheduleName is required for partial scan");
  }
  logger.setContext({ executionId, mode: "partial", scheduleId });
  logger.info(`Starting partial scan for schedule: ${scheduleId}`);
  const schedule = await fetchScheduleById(scheduleId);
  if (!schedule) {
    throw new Error(`Schedule not found: ${scheduleId}`);
  }
  const accounts = await fetchActiveAccounts();
  const targetAccounts = schedule.accountId ? accounts.filter((a) => a.accountId === schedule.accountId) : accounts;
  if (targetAccounts.length === 0) {
    logger.warn("No matching accounts found for schedule");
    return createResult(executionId, "partial", startTime, 1, 0, 0, 0);
  }
  const execParams = {
    scheduleId: schedule.scheduleId,
    scheduleName: schedule.name,
    tenantId: schedule.tenantId || "default",
    accountId: schedule.accountId || "system",
    triggeredBy
  };
  const execRecord = await createExecutionRecord(execParams);
  const allResults = [];
  const accountPromises = targetAccounts.map(
    (account) => processAccount(account, [schedule], executionId, triggeredBy)
  );
  const accountResults = await Promise.allSettled(accountPromises);
  for (const result of accountResults) {
    if (result.status === "fulfilled") {
      allResults.push(...result.value);
    }
  }
  const summary = summarizeResults(allResults);
  await updateExecutionRecord(execRecord, {
    status: summary.failed > 0 ? "partial" : "success",
    resourcesStarted: summary.started,
    resourcesStopped: summary.stopped,
    resourcesFailed: summary.failed
  });
  logger.info("Partial scan completed", summary);
  return createResult(
    executionId,
    "partial",
    startTime,
    1,
    summary.started,
    summary.stopped,
    summary.failed
  );
}
async function processAccount(account, schedules, executionId, _triggeredBy) {
  const results = [];
  const accountDispName = account.accountName || account.name || account.accountId;
  let regions = account.regions;
  if (typeof regions === "string") {
    regions = regions.split(",").map((r) => r.trim());
  }
  if (!Array.isArray(regions) || regions.length === 0) {
    logger.warn(`No regions configured for account ${accountDispName}`);
    return results;
  }
  const regionPromises = regions.map(async (region) => {
    try {
      const credentials = await assumeRole(account.roleArn, account.accountId, region);
      const metadata = {
        account: {
          name: accountDispName,
          accountId: account.accountId
        },
        region,
        executionId
      };
      const [ec2Results, rdsResults, ecsResults] = await Promise.all([
        processEC2Instances(schedules, credentials, metadata),
        processRDSInstances(schedules, credentials, metadata),
        processECSResources(schedules, credentials, metadata)
      ]);
      return [...ec2Results, ...rdsResults, ...ecsResults];
    } catch (error) {
      logger.error(`Error processing account ${accountDispName} in ${region}`, error);
      await createAuditLog({
        type: "audit_log",
        eventType: "scheduler.account.error",
        action: "process",
        user: "system",
        userType: "system",
        resourceType: "account",
        resourceId: account.accountId,
        status: "error",
        details: `Error processing account ${accountDispName} in ${region}: ${error instanceof Error ? error.message : String(error)}`,
        severity: "high",
        accountId: account.accountId,
        region
      });
      return [];
    }
  });
  const regionResults = await Promise.all(regionPromises);
  for (const regionResult of regionResults) {
    results.push(...regionResult);
  }
  return results;
}
function summarizeResults(results) {
  let started = 0;
  let stopped = 0;
  let failed = 0;
  for (const result of results) {
    if (!result.success) {
      failed++;
    } else if (result.action === "start") {
      started++;
    } else if (result.action === "stop") {
      stopped++;
    }
  }
  return { started, stopped, failed };
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
