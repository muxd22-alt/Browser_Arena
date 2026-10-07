// System One SDK for Unity (C#).
//
// Drop this file in. It is the whole integration: load a .s1b, verify it against
// the game spec hash, evaluate. The evaluator is a literal transcription of
// sdk/js/s1.js, and spec/golden.json is the proof they agree.
//
// Usage:
//
//     var brain = S1Brain.Load(path, specHash, spec.features.Length, spec.actions.Length);
//     // every decision tick, per unit:
//     game.Observe(unit, featuresSpan);            // your code fills 10 floats
//     var ctx   = brain.Gate(pressure, advantage, prevCtx, dwellTicks);
//     var act   = brain.Decide(featuresSpan, archetype, ctx);
//     game.Act(unit, act);                          // your code maps intent to controllers
//
// Thread safety: S1Brain is read-only after Load. Share one instance across all
// units and call Decide from the main thread.

using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace SystemOne
{
    /// <summary>Context indices. Order must match spec.contexts.</summary>
    public static class S1Ctx
    {
        public const int Execute = 0;
        public const int Default = 1;
        public const int Hold = 2;
        public const int Save = 3;
    }

    /// <summary>Raised when a .s1b does not belong to the running game.</summary>
    public class S1SpecMismatchException : Exception
    {
        public S1SpecMismatchException(string message) : base(message) { }
    }

    public sealed class S1Brain
    {
        public const string Magic = "S1B1";
        public const int HeaderBytes = 16;

        public uint Hash { get; private set; }
        public byte NFeatures { get; private set; }
        public byte NActions { get; private set; }
        public byte NContexts { get; private set; }
        public byte NArchetypes { get; private set; }
        public bool Gated { get; private set; }
        public int GateCount { get; private set; }
        public ushort MinDwellTicks { get; private set; }
        public int Bytes { get; private set; }

        // Body layout mirrors the reference implementation exactly.
        readonly sbyte[] _w;          // [nC][nA][nF]
        readonly sbyte[] _archBias;   // [nArch][nA]
        readonly sbyte[] _thresholds; // [gateCount]
        readonly float[] _scale;      // [nF]
        float _biasScale;

        S1Brain() { }

        public static S1Brain Load(byte[] bytes, uint expectedHash = 0)
        {
            if (bytes == null) throw new ArgumentNullException(nameof(bytes));
            if (bytes.Length < HeaderBytes) throw new ArgumentException("s1b: too short", nameof(bytes));
            for (int i = 0; i < 4; i++)
            {
                if (bytes[i] != (byte)Magic[i]) throw new ArgumentException("s1b: bad magic", nameof(bytes));
            }

            uint hash = BitConverter.ToUInt32(bytes, 4);
            if (expectedHash != 0 && hash != expectedHash)
            {
                throw new S1SpecMismatchException(
                    $"s1b: brain trained for a different spec (brain {hash:x8}, spec {expectedHash:x8})");
            }

            var b = new S1Brain
            {
                Hash = hash,
                NFeatures = bytes[8],
                NActions = bytes[9],
                NContexts = bytes[10],
                NArchetypes = bytes[11],
                Gated = (BitConverter.ToUInt16(bytes, 12) & 1) == 1,
                MinDwellTicks = BitConverter.ToUInt16(bytes, 14),
            };
            b.GateCount = b.Gated ? 4 : 1;

            int nW = b.NContexts * b.NActions * b.NFeatures;
            int nB = b.NArchetypes * b.NActions;
            int need = HeaderBytes + nW + nB + b.GateCount + b.NFeatures * 4 + 4;
            if (bytes.Length < need) throw new ArgumentException("s1b: truncated body", nameof(bytes));

            int o = HeaderBytes;
            b._w = new sbyte[nW];
            for (int i = 0; i < nW; i++) b._w[i] = unchecked((sbyte)bytes[o + i]);
            o += nW;
            b._archBias = new sbyte[nB];
            for (int i = 0; i < nB; i++) b._archBias[i] = unchecked((sbyte)bytes[o + i]);
            o += nB;
            b._thresholds = new sbyte[b.GateCount];
            for (int i = 0; i < b.GateCount; i++) b._thresholds[i] = unchecked((sbyte)bytes[o + i]);
            o += b.GateCount;
            b._scale = new float[b.NFeatures];
            for (int i = 0; i < b.NFeatures; i++)
            {
                b._scale[i] = BitConverter.ToSingle(bytes, o);
                o += 4;
            }
            b._biasScale = BitConverter.ToSingle(bytes, o);
            b.Bytes = need;
            return b;
        }

        public static S1Brain Load(string path, uint expectedHash = 0)
            => Load(File.ReadAllBytes(path), expectedHash);

        /// <summary>
        /// The evaluator. Note biasScale comes from scale[0]: the reference
        /// format reuses the first scale slot as the archetype-bias scale, and
        /// all three implementations keep that quirk so the bytes stay portable.
        /// </summary>
        public int Decide(ReadOnlySpan<float> f, int archetype, int context)
        {
            int best = -1;
            float bestScore = float.NegativeInfinity;
            float biasScale = _scale[0];
            int abase = archetype * NActions;
            for (int a = 0; a < NActions; a++)
            {
                float s = _archBias[abase + a] * biasScale;
                int row = (context * NActions + a) * NFeatures;
                for (int i = 0; i < NFeatures; i++) s += f[i] * _w[row + i] * _scale[i];
                if (s > bestScore) { bestScore = s; best = a; }
            }
            return best;
        }

        public void ScoreAll(ReadOnlySpan<float> f, int archetype, int context, Span<float> outScores)
        {
            float bs = _scale[0];
            int abase = archetype * NActions;
            for (int a = 0; a < NActions; a++)
            {
                float s = _archBias[abase + a] * bs;
                int row = (context * NActions + a) * NFeatures;
                for (int i = 0; i < NFeatures; i++) s += f[i] * _w[row + i] * _scale[i];
                outScores[a] = s;
            }
        }

        /// <summary>
        /// The gate. pressure and advantage come from your game, normalized to
        /// [-1,1]; dwell is how many ticks the current context has been held.
        /// </summary>
        public int Gate(float pressure, float advantage, int prevCtx, int dwellTicks)
        {
            if (!Gated) return S1Ctx.Default;
            if (prevCtx >= 0 && dwellTicks < MinDwellTicks) return prevCtx;
            float p = pressure, a = advantage;
            float t0 = _thresholds[0], t1 = _thresholds[1], t2 = _thresholds[2], t3 = _thresholds[3];
            if (p > t0 && a > t1) return S1Ctx.Execute;
            if (p < t2) return S1Ctx.Save;
            if (a < t3) return S1Ctx.Hold;
            return S1Ctx.Default;
        }

        /// <summary>X-ray. Fills contrib[] with the exact per-feature contribution to `action`.</summary>
        public void Explain(ReadOnlySpan<float> f, int archetype, int context, out int action,
                            Span<float> contrib, out float bias)
        {
            Span<float> scores = stackalloc float[32];
            ScoreAll(f, archetype, context, scores);
            action = 0;
            for (int a = 1; a < NActions; a++) if (scores[a] > scores[action]) action = a;
            bias = _archBias[archetype * NActions + action] * _scale[0];
            for (int i = 0; i < NFeatures; i++)
            {
                contrib[i] = f[i] * _w[(context * NActions + action) * NFeatures + i] * _scale[i];
            }
        }

        public sbyte Weight(int context, int action, int feature) => _w[(context * NActions + action) * NFeatures + feature];
        public float FeatureScale(int i) => _scale[i];
        public float BiasScale => _biasScale;
        public sbyte Threshold(int i) => _thresholds[i];
    }

    /// <summary>
    /// Contract 2 writer. One JSON line per decision, buffered, flushed on match
    /// end. Engine-agnostic: this is the only part a game needs to record.
    /// </summary>
    public sealed class S1Recorder
    {
        readonly System.Text.StringBuilder _sb = new System.Text.StringBuilder();
        readonly string _src;

        public S1Recorder(string src = "human")
        {
            _src = src;
            _sb.Append("{\"kind\":\"s1d\",\"s1\":1}\n");
        }

        public void Step(int tick, int unit, int archetype, ReadOnlySpan<float> features,
                         int context, int action, string src = null)
        {
            _sb.Append("{\"t\":").Append(tick)
               .Append(",\"u\":").Append(unit)
               .Append(",\"arch\":").Append(archetype)
               .Append(",\"f\":[");
            for (int i = 0; i < features.Length; i++)
            {
                if (i > 0) _sb.Append(',');
                _sb.Append(Math.Round(features[i], 3).ToString(System.Globalization.CultureInfo.InvariantCulture));
            }
            _sb.Append("],\"ctx\":").Append(context)
               .Append(",\"a\":").Append(action)
               .Append(",\"src\":\"").Append(src ?? _src).Append("\"}\n");
        }

        public void End(int tick, int win, int blueScore, int redScore)
        {
            _sb.Append("{\"t\":").Append(tick)
               .Append(",\"end\":{\"win\":").Append(win)
               .Append(",\"score\":[").Append(blueScore).Append(',').Append(redScore).Append("]}}\n");
        }

        public void Save(string path) => File.WriteAllText(path, _sb.ToString());
        public override string ToString() => _sb.ToString();
    }

    /// <summary>
    /// The game side of Contract 1. Implement this in your game; everything else
    /// in the pipeline is engine-agnostic.
    /// </summary>
    public interface IS1Game
    {
        /// <summary>Fill the feature buffer, one value per spec.features entry, all in [-1,1].</summary>
        void Observe(int unit, Span<float> features);

        /// <summary>Map a discrete intent to your own steering, aiming, animation.</summary>
        void Act(int unit, int actionIndex);
    }

    /// <summary>
    /// The difficulty dial: reaction delay, aim error, and a mistake rate driven
    /// by one slider. Make the brain as strong as you like, then dial it back so
    /// it feels fair instead of aimbot-like.
    /// </summary>
    public sealed class S1Humanizer
    {
        public readonly float Level;
        public readonly int ReactionTicks;
        public readonly float MistakeRate;

        System.Random _rng;
        readonly Dictionary<int, int> _pending = new Dictionary<int, int>();
        readonly Dictionary<int, int> _since = new Dictionary<int, int>();

        public S1Humanizer(float level, int seed = 1)
        {
            Level = Math.Max(0f, Math.Min(1f, level));
            ReactionTicks = (int)Math.Round(Level * 0.8f * 20f);
            MistakeRate = Level * 0.18f;
            _rng = new System.Random(seed);
        }

        public int Apply(int unit, int action, int tick, int actionCount, float archetypeBias = 1f)
        {
            if (Level <= 0f) return action;
            if (!_pending.TryGetValue(unit, out int pending))
            {
                pending = action;
                _pending[unit] = pending;
                _since[unit] = tick;
            }
            if (action != pending && tick - _since[unit] >= ReactionTicks)
            {
                _pending[unit] = action;
                _since[unit] = tick;
            }
            int current = _pending[unit];
            if (_rng.NextDouble() < MistakeRate * archetypeBias)
            {
                int n = _rng.Next(actionCount);
                return n == current ? (current + 1) % actionCount : n;
            }
            return current;
        }
    }

    /// <summary>Spec hash, so a game can compute the value its brains must carry.</summary>
    public static class S1Spec
    {
        // FNV-1a 32-bit. Hash the same canonical string the trainer hashes:
        // {"id":..,"features":[..],"actions":[..],"contexts":[..],"archetypes":[..],"gate":{"inputs":[..]}}
        public static uint Hash(JsonElement spec)
        {
            var sb = new System.Text.StringBuilder();
            sb.Append('{');
            AppendString(sb, "id", spec.GetProperty("id").GetString());
            AppendArray(sb, "features", spec.GetProperty("features"));
            AppendArray(sb, "actions", spec.GetProperty("actions"));
            AppendArray(sb, "contexts", spec.GetProperty("contexts"));
            AppendArray(sb, "archetypes", spec.GetProperty("archetypes"));
            sb.Append(",\"gate\":{\"inputs\":[");
            var inputs = spec.GetProperty("gate").GetProperty("inputs");
            for (int i = 0; i < inputs.GetArrayLength(); i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append('"').Append(inputs[i].GetString()).Append('"');
            }
            sb.Append("]}}");
            return Fnv1a32(sb.ToString());
        }

        static void AppendString(StringBuilder sb, string key, string value)
            => sb.Append('"').Append(key).Append("\":\"").Append(value).Append('"');

        static void AppendArray(StringBuilder sb, string key, JsonElement arr)
        {
            sb.Append('"').Append(key).Append("\":[");
            for (int i = 0; i < arr.GetArrayLength(); i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append('"').Append(arr[i].GetString()).Append('"');
            }
            sb.Append(']');
        }

        public static uint Fnv1a32(string s)
        {
            uint h = 0x811c9dc5u;
            foreach (char c in s)
            {
                h = unchecked((h ^ (c & 0xff)) * 0x01000193u);
                if (c > 0xff) h = unchecked((h ^ ((c >> 8) & 0xff)) * 0x01000193u);
            }
            return h;
        }
    }
}