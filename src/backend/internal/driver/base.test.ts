import test from "node:test"
import assert from "node:assert/strict"
import { calcFileType } from "./base"

test("F-111: .ts source files are classified as TEXT, not VIDEO", () => {
  assert.equal(calcFileType("app.ts", false), 4)
  assert.equal(calcFileType("movie.ts", false), 4)
  assert.equal(calcFileType("index.TS", false), 4)
})

test("F-111: MPEG-TS remains reachable through the m2ts extension", () => {
  assert.equal(calcFileType("stream.m2ts", false), 2)
  assert.equal(calcFileType("clip.mp4", false), 2)
  assert.equal(calcFileType("movie.mkv", false), 2)
})

test("calcFileType keeps the other categories intact", () => {
  assert.equal(calcFileType("dir", true), 1)
  assert.equal(calcFileType("song.mp3", false), 3)
  assert.equal(calcFileType("readme.md", false), 4)
  assert.equal(calcFileType("photo.png", false), 5)
  assert.equal(calcFileType("no-extension", false), 0)
  assert.equal(calcFileType("weird.zzz", false), 0)
})
