# System One SDK for Godot 4 (GDScript).
#
# Same wire format, same evaluator as sdk/js/s1.js and sdk/unity/S1.cs.
# spec/golden.json is the conformance check: run it in a headless Godot build
# in CI and assert every case.
#
# Usage:
#     var brain = S1Brain.load_file("res://brains/champion.s1b", expected_hash)
#     # every decision tick:
#     game.observe(unit, features)          # your code fills the array
#     var ctx = brain.gate(pressure, advantage, prev_ctx, dwell)
#     var act = brain.decide(features, archetype, ctx)
#     game.act(unit, act)                   # your code maps intent to controllers

class_name S1Brain
extends RefCounted

const MAGIC := "S1B1"
const HEADER_BYTES := 16

const CTX_EXECUTE := 0
const CTX_DEFAULT := 1
const CTX_HOLD := 2
const CTX_SAVE := 3

var hash: int = 0
var n_f: int = 0
var n_a: int = 0
var n_c: int = 0
var n_arch: int = 0
var gate_count: int = 1
var gated: bool = false
var min_dwell_ticks: int = 0
var byte_length: int = 0

var _w: PackedByteArray = PackedByteArray()
var _arch_bias: PackedByteArray = PackedByteArray()
var _thresholds: PackedByteArray = PackedByteArray()
var _scale: PackedFloat32Array = PackedFloat32Array()


static func load_file(path: String, expected_hash: int = 0) -> S1Brain:
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		push_error("s1b: cannot open %s" % path)
		return null
	var bytes := f.get_buffer(f.get_length())
	f.close()
	return load_bytes(bytes, expected_hash)


static func load_bytes(b: PackedByteArray, expected_hash: int = 0) -> S1Brain:
	if b.size() < HEADER_BYTES:
		push_error("s1b: too short")
		return null
	var magic := MAGIC.to_ascii_buffer()
	for i in 4:
		if b[i] != magic[i]:
			push_error("s1b: bad magic")
			return null

	var br := StreamPeerBuffer.new()
	br.big_endian = false
	br.data_array = b

	var brain := S1Brain.new()
	brain.hash = br.get_u32()
	if expected_hash != 0 and brain.hash != expected_hash:
		push_error("s1b: brain trained for a different spec (brain %x, spec %x)" % [brain.hash, expected_hash])
		return null
	brain.n_f = b[8]
	brain.n_a = b[9]
	brain.n_c = b[10]
	brain.n_arch = b[11]
	brain.gated = (br.get_u16() & 1) == 1
	brain.min_dwell_ticks = br.get_u16()
	brain.gate_count = 4 if brain.gated else 1

	var n_w := brain.n_c * brain.n_a * brain.n_f
	var n_b := brain.n_arch * brain.n_a
	var need := HEADER_BYTES + n_w + n_b + brain.gate_count + brain.n_f * 4 + 4
	if b.size() < need:
		push_error("s1b: truncated body")
		return null

	var o := HEADER_BYTES
	brain._w = b.slice(o, o + n_w)
	o += n_w
	brain._arch_bias = b.slice(o, o + n_b)
	o += n_b
	brain._thresholds = b.slice(o, o + brain.gate_count)
	o += brain.gate_count

	br.big_endian = false
	br.seek(o)
	var scales := PackedFloat32Array()
	scales.resize(brain.n_f)
	for i in brain.n_f:
		scales[i] = br.get_float()
	brain._scale = scales
	brain.byte_length = need
	return brain


# The evaluator. biasScale comes from scale[0]: the reference format reuses the
# first scale slot as the archetype-bias scale, and all three implementations
# keep that so the bytes stay portable.
func decide(f: PackedFloat32Array, archetype: int, context: int) -> int:
	var best := -1
	var best_score := -INF
	var bias_scale := _scale[0]
	var abase := archetype * n_a
	for a in n_a:
		var s := _arch_to_float(_arch_bias[abase + a]) * bias_scale
		var row := (context * n_a + a) * n_f
		for i in n_f:
			s += f[i] * _arch_to_float(_w[row + i]) * _scale[i]
		if s > best_score:
			best_score = s
			best = a
	return best


func score_all(f: PackedFloat32Array, archetype: int, context: int) -> PackedFloat32Array:
	var out := PackedFloat32Array()
	out.resize(n_a)
	var bias_scale := _scale[0]
	var abase := archetype * n_a
	for a in n_a:
		var s := _arch_to_float(_arch_bias[abase + a]) * bias_scale
		var row := (context * n_a + a) * n_f
		for i in n_f:
			s += f[i] * _arch_to_float(_w[row + i]) * _scale[i]
		out[a] = s
	return out


# pressure and advantage come from your game, normalized to [-1,1].
# dwell is how many ticks the current context has been held.
func gate(pressure: float, advantage: float, prev_ctx: int, dwell_ticks: int) -> int:
	if not gated:
		return CTX_DEFAULT
	if prev_ctx >= 0 and dwell_ticks < min_dwell_ticks:
		return prev_ctx
	var p := pressure
	var a := advantage
	if p > _th_to_float(_thresholds[0]) and a > _th_to_float(_thresholds[1]):
		return CTX_EXECUTE
	if p < _th_to_float(_thresholds[2]):
		return CTX_SAVE
	if a < _th_to_float(_thresholds[3]):
		return CTX_HOLD
	return CTX_DEFAULT


# X-ray: the exact per-feature contribution behind the chosen action.
func explain(f: PackedFloat32Array, archetype: int, context: int) -> Dictionary:
	var scores := score_all(f, archetype, context)
	var action := 0
	for a in range(1, n_a):
		if scores[a] > scores[action]:
			action = a
	var bias_scale := _scale[0]
	var bias := _arch_to_float(_arch_bias[archetype * n_a + action]) * bias_scale
	var contribs := PackedFloat32Array()
	contribs.resize(n_f)
	for i in n_f:
		contribs[i] = f[i] * _arch_to_float(_w[(context * n_a + action) * n_f + i]) * _scale[i]
	return {
		"action": action,
		"score": bias + _sum(contribs),
		"bias": bias,
		"contributions": contribs,
	}


func _arch_to_float(v: int) -> float:
	return v if v < 128 else v - 256


func _th_to_float(v: int) -> float:
	return v if v < 128 else v - 256


func _sum(a: PackedFloat32Array) -> float:
	var t := 0.0
	for v in a:
		t += v
	return t


# --------------------------------------------------------------------------
# Contract 2: the recording writer.
# --------------------------------------------------------------------------
class S1Recorder:
	extends RefCounted

	var _sb := PackedStringArray()
	var _src := "human"

	func _init(src := "human") -> void:
		_src = src
		_sb.append('{"kind":"s1d","s1":1}')

	func step(tick: int, unit: int, archetype: int, f: PackedFloat32Array,
			context: int, action: int, src := "") -> void:
		var parts := PackedStringArray()
		for v in f:
			parts.append(String.num(round(v, 3)))
		var vals := ",".join(parts)
		_sb.append('{"t":%d,"u":%d,"arch":%d,"f":[%s],"ctx":%d,"a":%d,"src":"%s"}' % [
			tick, unit, archetype, vals, context, action,
			src if src != "" else _src])

	func end(tick: int, win: int, blue: int, red: int) -> void:
		_sb.append('{"t":%d,"end":{"win":%d,"score":[%d,%d]}}' % [tick, win, blue, red])

	func save(path: String) -> void:
		var f := FileAccess.open(path, FileAccess.WRITE)
		f.store_string("\n".join(_sb) + "\n")
		f.close()

	func text() -> String:
		return "\n".join(_sb) + "\n"


# --------------------------------------------------------------------------
# The difficulty dial.
# --------------------------------------------------------------------------
class S1Humanizer:
	extends RefCounted

	var level := 0.0
	var reaction_ticks := 0
	var mistake_rate := 0.0
	var _rng := RandomNumberGenerator.new()
	var _pending := {}
	var _since := {}

	func _init(l := 0.0, seed_value := 1) -> void:
		level = clampf(l, 0.0, 1.0)
		reaction_ticks = int(round(level * 0.8 * 20.0))
		mistake_rate = level * 0.18
		_rng.seed = seed_value

	func apply(unit: int, action: int, tick: int, action_count: int, archetype_bias := 1.0) -> int:
		if level <= 0.0:
			return action
		if not _pending.has(unit):
			_pending[unit] = action
			_since[unit] = tick
		if action != _pending[unit] and tick - _since[unit] >= reaction_ticks:
			_pending[unit] = action
			_since[unit] = tick
		var current: int = _pending[unit]
		if _rng.randf() < mistake_rate * archetype_bias:
			var n := _rng.randi_range(0, action_count - 1)
			return (current + 1) % action_count if n == current else n
		return current