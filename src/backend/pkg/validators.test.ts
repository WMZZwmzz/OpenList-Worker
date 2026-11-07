import test from "node:test"
import assert from "node:assert/strict"
import {
  createUserRequestSchema,
  settingsUpdateRequestSchema,
  updateUserRequestSchema,
} from "./validators"
import { UserRole } from "./permission"

const baseUser = { username: "alice", password: "passw0rd" }

test("F-068: createUserRequestSchema uses the runtime UserRole enum", () => {
  // 2 必须是 ADMIN（旧注释把它说成「普通用户」）
  assert.equal(
    createUserRequestSchema.parse({ ...baseUser, role: 2 }).role,
    UserRole.ADMIN,
  )
  assert.equal(
    createUserRequestSchema.parse({ ...baseUser, role: 0 }).role,
    UserRole.GENERAL,
  )
  assert.equal(
    createUserRequestSchema.parse({ ...baseUser, role: 1 }).role,
    UserRole.GUEST,
  )
  // 3 不在枚举内（旧 schema 允许 0-3），必须拒绝
  assert.equal(
    createUserRequestSchema.safeParse({ ...baseUser, role: 3 }).success,
    false,
  )
  // 默认角色是普通用户，而不是 GUEST/ADMIN
  assert.equal(createUserRequestSchema.parse(baseUser).role, UserRole.GENERAL)
})

test("F-068: updateUserRequestSchema rejects out-of-enum roles", () => {
  assert.equal(updateUserRequestSchema.parse({ role: 2 }).role, UserRole.ADMIN)
  assert.equal(updateUserRequestSchema.safeParse({ role: 3 }).success, false)
  assert.equal(updateUserRequestSchema.parse({}).role, undefined)
})

test("F-068: settingsUpdateRequestSchema.default_role follows the enum", () => {
  assert.equal(
    settingsUpdateRequestSchema.parse({ default_role: 1 }).default_role,
    UserRole.GUEST,
  )
  assert.equal(
    settingsUpdateRequestSchema.safeParse({ default_role: 3 }).success,
    false,
  )
})
