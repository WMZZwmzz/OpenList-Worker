// Shared file sorting for drivers that honor order_by / order_direction
import { FileItem } from "./base"

/** order_by 键 -> 本地比较字段。未列出的键表示「驱动/上游已排好序」。 */
const SIZE_KEYS = new Set(["size", "file_size", "filesize", "file size"])
const MODIFIED_KEYS = new Set([
  "time",
  "mtime",
  "utime",
  "modified",
  "modified_at",
  "modified_time",
  "updated",
  "updated_at",
  "update_at",
  "lastoptime",
  "last_modified",
  "last_modified_at",
  "last_op_time",
  "server_modified",
])
const CREATED_KEYS = new Set([
  "created",
  "created_at",
  "create_at",
  "ctime",
  "creation_time",
  "created_time",
])
const NAME_KEYS = new Set(["name", "file_name", "filename", "folder", "title"])

type SortField = "size" | "modified" | "created" | "name"

function resolveSortField(key: string): SortField | null {
  if (SIZE_KEYS.has(key)) return "size"
  if (MODIFIED_KEYS.has(key)) return "modified"
  // F-110: created 类键必须真的比较 created（缺失时回退 modified），不能再
  // 复用 modified 比较器 —— 用户选了「按创建时间」却按修改时间排序。
  if (CREATED_KEYS.has(key)) return "created"
  if (NAME_KEYS.has(key)) return "name"
  return null
}

/** 时间字段解析：非法/缺失值按 0 处理，避免 NaN 让 sort 比较结果不确定。 */
function timeValue(value: string | undefined): number {
  if (!value) return 0
  const t = new Date(value).getTime()
  return Number.isFinite(t) ? t : 0
}

/**
 * Sort FileItems according to the driver's order settings.
 * Folders always come first (AList convention); files are then ordered by
 * name / modified time / created time / size per order_by, in asc or desc
 * direction.
 *
 * F-108: 键匹配改为精确集合。旧实现按子串匹配（size/time/modified/created），
 * 驱动表单里真实提供的 `updated_at` / `update_at` / `file_id` / `file_type`
 * 全部落空并静默回退成 name 序，覆盖掉上游 API 已经返回的排序。现在：
 *   - 认识的键映射到明确字段；
 *   - **不认识的键保持上游顺序**（不再回退 name），因为这类键（如 123Pan 的
 *     file_id）的语义就是「按驱动 API 的默认顺序」。
 */
export function sortFileItems(
  items: FileItem[],
  orderBy?: string,
  orderDirection?: string,
): FileItem[] {
  // F-109: 表单里的方向值有大写（AliyundriveOpen 的 "DESC"/"ASC"），旧比较
  // `orderDirection !== "desc"` 大小写敏感，导致「降序」被当成升序。
  const asc = String(orderDirection || "").toLowerCase() !== "desc"
  const key = String(orderBy || "name")
    .trim()
    .toLowerCase()
  const field = resolveSortField(key)
  // 未知 order_by：不改动上游顺序（只复制一份，避免调用方数组被原地排序）
  if (!field) return [...items]

  const sorted = [...items]
  sorted.sort((a, b) => {
    // Folders first
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1

    let cmp: number
    switch (field) {
      case "size":
        cmp = (a.size || 0) - (b.size || 0)
        break
      case "created": {
        const ac = a.created || a.modified
        const bc = b.created || b.modified
        cmp = timeValue(ac) - timeValue(bc)
        break
      }
      case "modified":
        cmp = timeValue(a.modified) - timeValue(b.modified)
        break
      default:
        cmp = String(a.name).localeCompare(String(b.name))
        break
    }
    return asc ? cmp : -cmp
  })
  return sorted
}
