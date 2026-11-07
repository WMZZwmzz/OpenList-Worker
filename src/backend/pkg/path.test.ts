import test from "node:test"
import assert from "node:assert/strict"
import {
  canonicalVirtualPath,
  collapsePathSegments,
  decodePathFully,
  hasParentSegment,
} from "./path"

test("F-075: legitimate dots inside a file name are preserved", () => {
  assert.equal(
    decodePathFully("/media/别哭了...(1).mp3"),
    "/media/别哭了...(1).mp3",
  )
  assert.equal(
    decodePathFully("/docs/backup...final.zip"),
    "/docs/backup...final.zip",
  )
  assert.equal(decodePathFully("/a/....b"), "/a/....b")
  assert.equal(canonicalVirtualPath("/media/别哭了...(1).mp3"), "/media/别哭了...(1).mp3")
})

test("F-075: whole-dot segments still normalize to '..' (traversal defence intact)", () => {
  // resolvePath 只折叠字面 ".."，整段点必须归一成 ".." 才保持同源
  assert.equal(decodePathFully("/a/.../b"), "/a/../b")
  assert.equal(decodePathFully("/a/..../b"), "/a/../b")
  assert.equal(decodePathFully("/a/%2e%2e/b"), "/a/../b")
  assert.equal(decodePathFully("/a/%252e%252e/b"), "/a/../b")
  // 编码后的整段点同样被归一
  assert.equal(decodePathFully("/a/%2e%2e%2e/b"), "/a/../b")
  assert.equal(decodePathFully("/a%2fb"), "/a/b")
  assert.equal(decodePathFully("/100%.txt"), "/100%.txt")
})

test("F-075: canonical view folds whole-dot segments but keeps embedded dots", () => {
  assert.equal(canonicalVirtualPath("/a/.../b"), "/b")
  assert.equal(canonicalVirtualPath("/a/..."), "/")
  assert.equal(canonicalVirtualPath("/a/....b"), "/a/....b")
  assert.equal(hasParentSegment("/a/.../b"), true)
  assert.equal(hasParentSegment("/a/....b"), false)
})

test("F-075: collapsePathSegments keeps clamping at the stack limit", () => {
  assert.deepEqual(collapsePathSegments("/u1/../x", 1), ["u1", "x"])
  assert.deepEqual(collapsePathSegments("/u1/x/../../y", 1), ["u1", "y"])
  assert.deepEqual(collapsePathSegments("/u1/.../x", 1), ["u1", "x"])
})
