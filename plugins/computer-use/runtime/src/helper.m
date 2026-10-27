// helper — macOS 桌面操作原生助手（元素树 + CGEvent 键鼠）
//
// 两条能力面：
//   1. AX（AXUIElement）：元素树、按名字 AXPress、读写控件值、网页文本、等元素出现
//      —— 比 AppleScript 的 `entire contents` 快两个数量级，且 AXPress 是后台投递
//   2. 输入（CGEvent）：鼠标移动/点击/拖拽/滚轮、键盘 typing / 单键 / 组合键
//      —— 自己在进程内合成事件，不需要任何 npm 原生模块
//
// 编译（首次使用时由 scripts/desktop.mjs 自动执行）：
//   clang -O2 -framework ApplicationServices -framework CoreGraphics -framework Foundation \
//         src/helper.m -o bin/helper
//
// 输出恒为 JSON；失败时输出 {"error": "..."} 并以非零码退出。
// 诊断信息（例如元素树被截断）走 stderr。

#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#include <libproc.h>
#include <ctype.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAXNODES 5000
#define SBUF 256
#define LBUF 512

// MARK: - 输出工具

static void jsonEscape(const char *in, char *out, size_t outsz) {
    size_t j = 0;
    if (!in) { out[0] = 0; return; }
    for (size_t i = 0; in[i] && j + 8 < outsz; i++) {
        unsigned char c = (unsigned char)in[i];
        if (c == '"' || c == '\\') { out[j++] = '\\'; out[j++] = (char)c; }
        else if (c == '\n') { out[j++] = '\\'; out[j++] = 'n'; }
        else if (c == '\r') { out[j++] = '\\'; out[j++] = 'r'; }
        else if (c == '\t') { out[j++] = '\\'; out[j++] = 't'; }
        else if (c < 0x20) { j += (size_t)snprintf(out + j, outsz - j, "\\u%04x", c); }
        else out[j++] = (char)c;
    }
    out[j] = 0;
}

// 错误也走 JSON：调用方（desktop.mjs / 脚本）只解析一种输出形态
static int failJson(const char *fmt, ...) {
    char buf[1024];
    char esc[2100];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    jsonEscape(buf, esc, sizeof(esc));
    printf("{\"error\":\"%s\"}\n", esc);
    return 1;
}

// 把 CF 值转成 UTF-8 C 字符串
static const char *cstr(CFTypeRef v, char *buf, size_t sz) {
    buf[0] = 0;
    if (!v) return buf;
    CFTypeID t = CFGetTypeID(v);
    if (t == CFStringGetTypeID()) {
        CFStringGetCString((CFStringRef)v, buf, (CFIndex)sz, kCFStringEncodingUTF8);
    } else if (t == CFNumberGetTypeID()) {
        double d = 0;
        CFNumberGetValue((CFNumberRef)v, kCFNumberDoubleType, &d);
        snprintf(buf, sz, "%g", d);
    } else if (t == CFBooleanGetTypeID()) {
        snprintf(buf, sz, "%s", CFBooleanGetValue((CFBooleanRef)v) ? "true" : "false");
    }
    return buf;
}

static CFTypeRef copyAttr(AXUIElementRef el, CFStringRef name) {
    CFTypeRef v = NULL;
    if (AXUIElementCopyAttributeValue(el, name, &v) != kAXErrorSuccess) return NULL;
    return v;
}

static void lowerInPlace(char *s) {
    for (size_t i = 0; s[i]; i++) s[i] = (char)tolower((unsigned char)s[i]);
}

static void lowerInto(const char *in, char *out, size_t sz) {
    size_t i;
    for (i = 0; in && in[i] && i < sz - 1; i++) out[i] = (char)tolower((unsigned char)in[i]);
    out[i] = 0;
}

// MARK: - 节点

typedef struct {
    uintptr_t el;
    char role[SBUF];
    char title[LBUF];
    char value[LBUF];
    char desc[LBUF];
    double x, y, w, h;
    int hasFrame;
    int depth;
    int pressable;
    int focused;
    int settable;
    int score;
    char actions[256];
} Node;

static Node gNodes[MAXNODES];
static int gCount = 0;
// 真实页面（维基百科 / GitHub）实测都会超过 14 层，默认放到 24。
// 注意：find / press / webtext 走流式遍历（gScanDepth），不受这两个上限影响。
static int gMaxDepth = 24;
static int gTruncated = 0;
static int gLimit = MAXNODES;
// 菜单栏不在 kAXWindows 里，要单独遍历；默认 find/press 带上（由调用方 wantMenus 决定），
// tree 不带（避免刷屏）。
static int gMenus = -1; // -1 = 按命令自动
// wait-el 默认超时
static int gTimeoutMs = 5000;

static void makeNode(AXUIElementRef el, int depth, Node *n) {
    memset(n, 0, sizeof(Node));
    // 必须 retain：父级 children 数组在 collect 里会被 release，
    // 存裸指针会在后续 press/setval 时变成悬空引用（曾导致 SIGTRAP 崩溃）
    n->el = (uintptr_t)CFRetain(el);
    n->depth = depth;

    CFTypeRef v;
    if ((v = copyAttr(el, kAXRoleAttribute))) { cstr(v, n->role, SBUF); CFRelease(v); }
    if ((v = copyAttr(el, kAXTitleAttribute))) { cstr(v, n->title, LBUF); CFRelease(v); }
    if ((v = copyAttr(el, kAXValueAttribute))) { cstr(v, n->value, LBUF); CFRelease(v); }
    if ((v = copyAttr(el, kAXDescriptionAttribute))) { cstr(v, n->desc, LBUF); CFRelease(v); }

    CFArrayRef actions = NULL;
    if (AXUIElementCopyActionNames(el, &actions) == kAXErrorSuccess && actions) {
        for (CFIndex i = 0; i < CFArrayGetCount(actions); i++) {
            CFStringRef a = (CFStringRef)CFArrayGetValueAtIndex(actions, i);
            if (a) {
                char ab[64];
                if (CFStringGetCString(a, ab, sizeof(ab), kCFStringEncodingUTF8)) {
                    if (n->actions[0]) {
                        strncat(n->actions, ",", sizeof(n->actions) - strlen(n->actions) - 1);
                    }
                    strncat(n->actions, ab, sizeof(n->actions) - strlen(n->actions) - 1);
                }
            }
            if (a && CFStringCompare(a, kAXPressAction, 0) == kCFCompareEqualTo) {
                n->pressable = 1;
            }
        }
        CFRelease(actions);
    }

    // 焦点 / 可写状态：AXPress 与 setval 的成败都取决于它们，诊断时需要看到
    CFTypeRef fv = copyAttr(el, kAXFocusedAttribute);
    if (fv) {
        if (CFGetTypeID(fv) == CFBooleanGetTypeID()) {
            n->focused = CFBooleanGetValue((CFBooleanRef)fv) ? 1 : 0;
        }
        CFRelease(fv);
    }
    Boolean settable = 0;
    if (AXUIElementIsAttributeSettable(el, kAXValueAttribute, &settable) == kAXErrorSuccess) {
        n->settable = settable ? 1 : 0;
    }

    AXValueRef pos = (AXValueRef)copyAttr(el, kAXPositionAttribute);
    AXValueRef size = (AXValueRef)copyAttr(el, kAXSizeAttribute);
    if (pos && CFGetTypeID(pos) == AXValueGetTypeID() &&
        size && CFGetTypeID(size) == AXValueGetTypeID()) {
        CGPoint p;
        CGSize s;
        if (AXValueGetValue(pos, kAXValueCGPointType, &p) &&
            AXValueGetValue(size, kAXValueCGSizeType, &s)) {
            n->x = p.x; n->y = p.y; n->w = s.width; n->h = s.height;
            n->hasFrame = 1;
        }
    }
    if (pos) CFRelease(pos);
    if (size) CFRelease(size);
}

static void collect(AXUIElementRef el, int depth) {
    if (gCount >= gLimit || depth > gMaxDepth) { gTruncated = 1; return; }
    makeNode(el, depth, &gNodes[gCount]);
    gCount++;

    CFTypeRef v = copyAttr(el, kAXChildrenAttribute);
    if (!v) return;
    if (CFGetTypeID(v) != CFArrayGetTypeID()) { CFRelease(v); return; }
    CFArrayRef arr = (CFArrayRef)v;
    for (CFIndex i = 0; i < CFArrayGetCount(arr); i++) {
        if (gCount >= gLimit) { gTruncated = 1; break; }
        AXUIElementRef c = (AXUIElementRef)CFArrayGetValueAtIndex(arr, i);
        if (c) collect(c, depth + 1);
    }
    CFRelease(v);
}

// MARK: - 流式遍历（真实页面必需）
//
// 「先把整棵树存进数组再匹配」在真实网页上会截断：维基百科长条目超过 5000 节点，
// 正文后半段整个丢失（实测 macOS 条目读到 2014 年的 10.10 就没了）；
// 深度上限 14 也会被真实页面撞到。
// 所以查找 / 点击 / 读网页文本改成 **流式遍历**：不保留整棵树，遍历时直接判定或输出，
// 于是节点数不再有上限，深度也放大。`els`（整树导出）仍保留上限，因为它的用途是给人看。
typedef void (*NodeVisitor)(Node *n, void *ctx);

static int gScanDepth = 40;   // 流式遍历的最大深度
static int gVisits = 0;       // 本次实际访问的节点数（用于报告）

static void walk(AXUIElementRef el, int depth, NodeVisitor visit, void *ctx) {
    if (!el || depth > gScanDepth) return;
    Node n;
    makeNode(el, depth, &n);
    gVisits++;
    visit(&n, ctx);
    // 流式：不保留，立刻释放（makeNode 里 retain 过）
    CFRelease((CFTypeRef)n.el);

    CFTypeRef v = copyAttr(el, kAXChildrenAttribute);
    if (!v) return;
    if (CFGetTypeID(v) != CFArrayGetTypeID()) { CFRelease(v); return; }
    CFArrayRef arr = (CFArrayRef)v;
    for (CFIndex i = 0; i < CFArrayGetCount(arr); i++) {
        walk((AXUIElementRef)CFArrayGetValueAtIndex(arr, i), depth + 1, visit, ctx);
    }
    CFRelease(v);
}

static void walkRoots(AXUIElementRef app, int wantMenus, NodeVisitor visit, void *ctx) {
    CFTypeRef v = copyAttr(app, kAXWindowsAttribute);
    int done = 0;
    if (v && CFGetTypeID(v) == CFArrayGetTypeID()) {
        CFArrayRef arr = (CFArrayRef)v;
        if (CFArrayGetCount(arr) > 0) {
            for (CFIndex i = 0; i < CFArrayGetCount(arr); i++) {
                walk((AXUIElementRef)CFArrayGetValueAtIndex(arr, i), 0, visit, ctx);
            }
            done = 1;
        }
    }
    if (v) CFRelease(v);
    if (!done) walk(app, 0, visit, ctx);

    int menus = (gMenus == -1) ? wantMenus : gMenus;
    if (menus) {
        CFTypeRef mb = copyAttr(app, kAXMenuBarAttribute);
        if (mb) {
            walk((AXUIElementRef)mb, 0, visit, ctx);
            CFRelease(mb);
        }
    }
}

static int isMatch(const Node *n, const char *q) {
    char ql[SBUF], buf[LBUF];
    size_t i;
    for (i = 0; q[i] && i < SBUF - 1; i++) ql[i] = (char)tolower((unsigned char)q[i]);
    ql[i] = 0;

    char tmp[LBUF];
    snprintf(tmp, LBUF, "%s", n->title);
    for (i = 0; tmp[i]; i++) tmp[i] = (char)tolower((unsigned char)tmp[i]);
    if (strcmp(tmp, ql) == 0) return 1;
    if (tmp[0] && strstr(tmp, ql)) return 1;

    snprintf(tmp, LBUF, "%s", n->value);
    for (i = 0; tmp[i]; i++) tmp[i] = (char)tolower((unsigned char)tmp[i]);
    if (tmp[0] && strstr(tmp, ql)) return 1;

    snprintf(tmp, LBUF, "%s", n->desc);
    for (i = 0; tmp[i]; i++) tmp[i] = (char)tolower((unsigned char)tmp[i]);
    if (tmp[0] && strstr(tmp, ql)) return 1;

    snprintf(tmp, SBUF, "%s", n->role);
    for (i = 0; tmp[i]; i++) tmp[i] = (char)tolower((unsigned char)tmp[i]);
    if (strstr(tmp, ql)) return 1;

    (void)buf;
    return 0;
}

static int scoreOf(const Node *n, const char *q) {
    char ql[SBUF], tmp[LBUF], tmpv[LBUF], tmpd[LBUF];
    size_t i;
    for (i = 0; q[i] && i < SBUF - 1; i++) ql[i] = (char)tolower((unsigned char)q[i]);
    ql[i] = 0;
    snprintf(tmp, LBUF, "%s", n->title);
    lowerInPlace(tmp);
    snprintf(tmpv, LBUF, "%s", n->value);
    lowerInPlace(tmpv);
    snprintf(tmpd, LBUF, "%s", n->desc);
    lowerInPlace(tmpd);

    int s = 0;
    if (strcmp(tmp, ql) == 0) s += 1000;           // 标题完全相等
    else if (tmp[0] && strstr(tmp, ql)) s += 500;  // 标题包含
    // 很多 App（计算器、部分原生控件）把标签放在 description 而不是 title
    if (strcmp(tmpd, ql) == 0) s += 800;
    else if (tmpd[0] && strstr(tmpd, ql)) s += 400;
    if (strcmp(tmpv, ql) == 0) s += 600;
    else if (tmpv[0] && strstr(tmpv, ql)) s += 300;
    if (n->pressable) s += 200;
    if (n->hasFrame && n->w > 0 && n->h > 0) {
        double area = n->w * n->h;
        if (area > 200000) area = 200000;
        s += 200 - (int)(area / 1000); // 面积越小越具体
    } else {
        // 没有可见尺寸的多半是菜单项 / 屏幕外元素，不能当作"小而具体"的正例
        s -= 250;
    }
    // 菜单项默认降权：否则"按名字点按钮"会静默点到同名菜单项（例如计算器的 "1"）
    if (strstr(n->role, "MenuItem") || strcmp(n->role, "AXMenuBarItem") == 0) s -= 600;
    return s;
}

// MARK: - 目标解析

// 0=不匹配 1=包含 2=完全相等
static int nameRank(const char *cand, const char *specLower) {
    if (!cand || !cand[0]) return 0;
    char cl[SBUF];
    lowerInto(cand, cl, SBUF);
    if (strcmp(cl, specLower) == 0) return 2;
    if (strstr(cl, specLower)) return 1;
    return 0;
}

// 取可执行文件名与 .app 包名（app 名是本地化的，英文名只能靠这两个兜底）
static void pidExeNames(pid_t pid, char *base, size_t bsz, char *bundle, size_t usize) {
    base[0] = 0;
    bundle[0] = 0;
    char path[PROC_PIDPATHINFO_MAXSIZE];
    if (proc_pidpath(pid, path, sizeof(path)) <= 0) return;
    char *slash = strrchr(path, '/');
    snprintf(base, bsz, "%s", slash ? slash + 1 : path);
    char *app = strstr(path, ".app/");
    if (app) {
        char *start = app;
        while (start > path && *(start - 1) != '/') start--;
        size_t len = (size_t)(app - start);
        if (len >= usize) len = usize - 1;
        memcpy(bundle, start, len);
        bundle[len] = 0;
    }
}

// 按进程列表兜底解析：app 可能一个可见窗口都没有（例如 Finder 关掉了所有窗口），
// 这时只看"有窗口的 app"会找不到它。
static pid_t resolveByProcesses(const char *specLower) {
    int bytes = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
    if (bytes <= 0) return 0;
    pid_t *pids = (pid_t *)malloc((size_t)bytes);
    if (!pids) return 0;
    int n = proc_listpids(PROC_ALL_PIDS, 0, pids, bytes);
    int count = n > 0 ? n / (int)sizeof(pid_t) : 0;

    pid_t best = 0;
    int bestRank = 0;
    for (int i = 0; i < count; i++) {
        pid_t p = pids[i];
        if (p <= 1) continue;
        char name[256];
        name[0] = 0;
        proc_name(p, name, sizeof(name));
        char exe[SBUF], bundle[SBUF];
        pidExeNames(p, exe, SBUF, bundle, SBUF);

        int r = nameRank(name, specLower) * 2;
        int re = nameRank(exe, specLower);
        if (re > 0 && r == 0) r = re;
        int rb = nameRank(bundle, specLower);
        if (rb > 0 && r == 0) r = rb;

        if (r > bestRank) { bestRank = r; best = p; }
        if (bestRank >= 4) break; // 完全匹配
    }
    free(pids);
    return best;
}

static pid_t resolvePid(const char *spec) {
    char *end = NULL;
    long n = strtol(spec, &end, 10);
    if (end && *end == 0 && n > 1 && kill((pid_t)n, 0) == 0) return (pid_t)n;

    char sl[SBUF];
    lowerInto(spec, sl, SBUF);

    CFArrayRef wins = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (!wins) return 0;

    pid_t bestPid = 0;
    int bestRank = 0;
    pid_t seen[256];
    int nseen = 0;

    for (CFIndex k = 0; k < CFArrayGetCount(wins); k++) {
        CFDictionaryRef w = (CFDictionaryRef)CFArrayGetValueAtIndex(wins, k);
        CFNumberRef layer = (CFNumberRef)CFDictionaryGetValue(w, kCGWindowLayer);
        int lv = 0;
        if (layer) CFNumberGetValue(layer, kCFNumberIntType, &lv);
        if (lv != 0) continue;
        CFNumberRef pidv = (CFNumberRef)CFDictionaryGetValue(w, kCGWindowOwnerPID);
        CFStringRef owner = (CFStringRef)CFDictionaryGetValue(w, kCGWindowOwnerName);
        if (!pidv) continue;

        int p = 0;
        CFNumberGetValue(pidv, kCFNumberIntType, &p);
        int dup = 0;
        for (int q = 0; q < nseen; q++) if (seen[q] == (pid_t)p) { dup = 1; break; }
        if (dup) continue;
        if (nseen < 256) seen[nseen++] = (pid_t)p;

        char obuf[SBUF];
        obuf[0] = 0;
        if (owner) CFStringGetCString(owner, obuf, SBUF, kCFStringEncodingUTF8);

        char exe[SBUF], bundle[SBUF];
        pidExeNames((pid_t)p, exe, SBUF, bundle, SBUF);

        // 本地化 owner 名优先，可执行名/.app 名兜底
        int r = nameRank(obuf, sl) * 2;
        int re = nameRank(exe, sl);
        if (re > 0 && r == 0) r = re;
        int rb = nameRank(bundle, sl);
        if (rb > 0 && r == 0) r = rb;

        if (r > bestRank) { bestRank = r; bestPid = (pid_t)p; }
        if (bestRank >= 4) break; // owner 完全匹配，最优
    }
    CFRelease(wins);
    // 没有可见窗口的 app（如关闭了所有窗口的 Finder）走进程列表兜底
    if (bestPid == 0) bestPid = resolveByProcesses(sl);
    return bestPid;
}

static AXUIElementRef appElement(const char *spec, int *outPid) {
    pid_t pid = resolvePid(spec);
    if (pid <= 0) {
        failJson("找不到有窗口的 app 或 pid: %s", spec);
        exit(1);
    }
    if (outPid) *outPid = pid;
    return AXUIElementCreateApplication(pid);
}

static void collectRoots(AXUIElementRef app, int wantMenus) {
    CFTypeRef v = copyAttr(app, kAXWindowsAttribute);
    int done = 0;
    if (v && CFGetTypeID(v) == CFArrayGetTypeID()) {
        CFArrayRef arr = (CFArrayRef)v;
        if (CFArrayGetCount(arr) > 0) {
            for (CFIndex i = 0; i < CFArrayGetCount(arr); i++) {
                if (gCount >= gLimit) { gTruncated = 1; break; }
                AXUIElementRef w = (AXUIElementRef)CFArrayGetValueAtIndex(arr, i);
                if (w) collect(w, 0);
            }
            done = 1;
        }
    }
    if (v) CFRelease(v);
    if (!done) collect(app, 0);

    // 菜单栏独立于窗口：AXPress 菜单项是坐标点击做不到的（下拉菜单点开就会关）
    int menus = (gMenus == -1) ? wantMenus : gMenus;
    if (menus && gCount < gLimit) {
        CFTypeRef mb = copyAttr(app, kAXMenuBarAttribute);
        if (mb) {
            collect((AXUIElementRef)mb, 0);
            CFRelease(mb);
        }
    }
}

// MARK: - AX 命令输出

static void printNodeJSON(const Node *n, int last) {
    char eRole[SBUF * 2], eTitle[LBUF * 2], eValue[LBUF * 2], eDesc[LBUF * 2];
    char eAct[600];
    jsonEscape(n->role, eRole, sizeof(eRole));
    jsonEscape(n->title, eTitle, sizeof(eTitle));
    jsonEscape(n->value, eValue, sizeof(eValue));
    jsonEscape(n->desc, eDesc, sizeof(eDesc));
    jsonEscape(n->actions, eAct, sizeof(eAct));

    printf("{\"role\":\"%s\",\"title\":\"%s\",\"value\":\"%s\",\"desc\":\"%s\",\"depth\":%d,"
           "\"pressable\":%s,\"focused\":%s,\"settable\":%s,\"actions\":\"%s\"",
           eRole, eTitle, eValue, eDesc, n->depth,
           n->pressable ? "true" : "false",
           n->focused ? "true" : "false",
           n->settable ? "true" : "false",
           eAct);
    if (n->hasFrame) {
        printf(",\"x\":%.1f,\"y\":%.1f,\"w\":%.1f,\"h\":%.1f,\"cx\":%.1f,\"cy\":%.1f",
               n->x, n->y, n->w, n->h, n->x + n->w / 2, n->y + n->h / 2);
    }
    printf("}%s", last ? "" : ",");
}

static void cmdApps(void) {
    CFArrayRef wins = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    printf("[");
    if (wins) {
        pid_t seen[256];
        int nseen = 0, first = 1;
        for (CFIndex i = 0; i < CFArrayGetCount(wins); i++) {
            CFDictionaryRef w = (CFDictionaryRef)CFArrayGetValueAtIndex(wins, i);
            CFNumberRef layer = (CFNumberRef)CFDictionaryGetValue(w, kCGWindowLayer);
            int lv = 0;
            if (layer) CFNumberGetValue(layer, kCFNumberIntType, &lv);
            if (lv != 0) continue;
            CFNumberRef pidv = (CFNumberRef)CFDictionaryGetValue(w, kCGWindowOwnerPID);
            CFStringRef owner = (CFStringRef)CFDictionaryGetValue(w, kCGWindowOwnerName);
            if (!pidv || !owner) continue;
            int p = 0;
            CFNumberGetValue(pidv, kCFNumberIntType, &p);
            int dup = 0;
            for (int k = 0; k < nseen; k++) if (seen[k] == (pid_t)p) { dup = 1; break; }
            if (dup || nseen >= 256) continue;
            seen[nseen++] = (pid_t)p;
            char buf[SBUF], esc[SBUF * 2];
            if (!CFStringGetCString(owner, buf, SBUF, kCFStringEncodingUTF8)) continue;
            jsonEscape(buf, esc, sizeof(esc));
            printf("%s{\"pid\":%d,\"name\":\"%s\"}", first ? "" : ",", p, esc);
            first = 0;
        }
        CFRelease(wins);
    }
    printf("]\n");
}

static void cmdFrontmost(void) {
    CFArrayRef wins = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (wins) {
        for (CFIndex i = 0; i < CFArrayGetCount(wins); i++) {
            CFDictionaryRef w = (CFDictionaryRef)CFArrayGetValueAtIndex(wins, i);
            CFNumberRef layer = (CFNumberRef)CFDictionaryGetValue(w, kCGWindowLayer);
            int lv = 0;
            if (layer) CFNumberGetValue(layer, kCFNumberIntType, &lv);
            if (lv != 0) continue;
            CFNumberRef pidv = (CFNumberRef)CFDictionaryGetValue(w, kCGWindowOwnerPID);
            CFStringRef owner = (CFStringRef)CFDictionaryGetValue(w, kCGWindowOwnerName);
            if (!pidv || !owner) continue;
            int p = 0;
            CFNumberGetValue(pidv, kCFNumberIntType, &p);
            char buf[SBUF], esc[SBUF * 2];
            CFStringGetCString(owner, buf, SBUF, kCFStringEncodingUTF8);
            jsonEscape(buf, esc, sizeof(esc));
            printf("{\"pid\":%d,\"name\":\"%s\"}\n", p, esc);
            CFRelease(wins);
            return;
        }
        CFRelease(wins);
    }
    printf("{\"pid\":0,\"name\":\"\"}\n");
}

static int cmdWindows(const char *spec) {
    pid_t pid = resolvePid(spec);
    if (pid <= 0) return failJson("找不到 app: %s", spec);
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    CFTypeRef v = copyAttr(app, kAXWindowsAttribute);
    printf("[");
    if (v && CFGetTypeID(v) == CFArrayGetTypeID()) {
        CFArrayRef arr = (CFArrayRef)v;
        for (CFIndex i = 0; i < CFArrayGetCount(arr); i++) {
            AXUIElementRef w = (AXUIElementRef)CFArrayGetValueAtIndex(arr, i);
            char title[LBUF], esc[LBUF * 2], tbuf[SBUF];
            title[0] = 0;
            CFTypeRef tv = copyAttr(w, kAXTitleAttribute);
            if (tv) { cstr(tv, tbuf, SBUF); snprintf(title, LBUF, "%s", tbuf); CFRelease(tv); }
            jsonEscape(title, esc, sizeof(esc));
            printf("%s{\"index\":%ld,\"title\":\"%s\"", i == 0 ? "" : ",", (long)i, esc);
            AXValueRef pos = (AXValueRef)copyAttr(w, kAXPositionAttribute);
            AXValueRef size = (AXValueRef)copyAttr(w, kAXSizeAttribute);
            if (pos && size && CFGetTypeID(pos) == AXValueGetTypeID() &&
                CFGetTypeID(size) == AXValueGetTypeID()) {
                CGPoint p; CGSize s;
                if (AXValueGetValue(pos, kAXValueCGPointType, &p) &&
                    AXValueGetValue(size, kAXValueCGSizeType, &s)) {
                    printf(",\"x\":%.1f,\"y\":%.1f,\"w\":%.1f,\"h\":%.1f", p.x, p.y, s.width, s.height);
                }
            }
            if (pos) CFRelease(pos);
            if (size) CFRelease(size);
            printf("}");
        }
        CFRelease(v);
    }
    printf("]\n");
    CFRelease(app);
    return 0;
}

// MARK: - Web 内容 / 运行时开关 / 等待

// 释放上一轮采集 retain 的元素（wait-el 轮询时避免无限累积）
static void resetNodes(void) {
    for (int i = 0; i < gCount; i++) {
        if (gNodes[i].el) CFRelease((CFTypeRef)gNodes[i].el);
    }
    gCount = 0;
}

// 携带可见文本的 role
static int isTextRole(const char *role) {
    static const char *roles[] = {
        "AXStaticText", "AXHeading", "AXLink", "AXButton", "AXTextField",
        "AXTextArea", "AXCheckBox", "AXRadioButton", "AXComboBox",
        "AXPopUpButton", "AXMenuItem", "AXImage", "AXCell", "AXColumnTitle",
        NULL
    };
    for (int i = 0; roles[i]; i++) {
        if (strcmp(role, roles[i]) == 0) return 1;
    }
    return 0;
}

// 输入类元素的「内容」在 value 上，其余元素的「内容」在 title 上。
// 反了会把 AXHeading 的层级数字（value="1"）当成标题文本。
static int isValueFirstRole(const char *role) {
    return strcmp(role, "AXTextField") == 0 ||
           strcmp(role, "AXTextArea") == 0 ||
           strcmp(role, "AXComboBox") == 0;
}

static const char *nodeText(const Node *n) {
    if (isValueFirstRole(n->role)) {
        if (n->value[0]) return n->value;
        if (n->title[0]) return n->title;
        return n->desc;
    }
    if (n->title[0]) return n->title;
    if (n->value[0]) return n->value;
    return n->desc;
}

static int isBlankText(const char *s) {
    if (!s) return 1;
    for (; *s; s++) {
        if (!isspace((unsigned char)*s)) return 0;
    }
    return 1;
}

// 只输出网页区域（AXWebArea 子树）的文本，按文档顺序。
// 浏览器任务用它拿「页面可读内容」，不必截图 + OCR。
//
// 流式实现：真实网页动辄上万节点，边遍历边输出，不再受节点数上限约束。
typedef struct {
    int webDepth;   // -1 = 当前不在网页区域内
    int first;
    int printed;
    char lastText[LBUF];
    int lastDepth;
} WebCtx;

static void visitWeb(Node *n, void *ctxp) {
    WebCtx *c = (WebCtx *)ctxp;
    if (strcmp(n->role, "AXWebArea") == 0) { c->webDepth = n->depth; return; }
    if (c->webDepth < 0) return;
    // 前序 DFS：深度回落到网页区域那一层即已离开它
    if (n->depth <= c->webDepth) { c->webDepth = -1; return; }
    if (!isTextRole(n->role)) return;

    const char *t = nodeText(n);
    if (!t || !t[0] || isBlankText(t)) return;
    // 容器节点与紧随其后的文本子节点文本相同时只保留一个
    if (strcmp(t, c->lastText) == 0 && n->depth > c->lastDepth) return;

    char er[SBUF * 2], et[LBUF * 2];
    jsonEscape(n->role, er, sizeof(er));
    jsonEscape(t, et, sizeof(et));
    if (!c->first) printf(",");
    c->first = 0;
    c->printed++;
    printf("{\"role\":\"%s\",\"text\":\"%s\"}", er, et);
    snprintf(c->lastText, sizeof(c->lastText), "%s", t);
    c->lastDepth = n->depth;
}

static void cmdWebtext(const char *spec) {
    AXUIElementRef app = appElement(spec, NULL);
    WebCtx c;
    memset(&c, 0, sizeof(c));
    c.webDepth = -1;
    c.first = 1;
    gMenus = 0;  // 菜单栏不是网页内容
    printf("[");
    walkRoots(app, 0, visitWeb, &c);
    printf("]\n");
    CFRelease(app);
}

// 元素树里是否已出现网页区域
static int hasWebArea(AXUIElementRef app) {
    resetNodes();
    collectRoots(app, 0);
    for (int i = 0; i < gCount; i++) {
        if (strcmp(gNodes[i].role, "AXWebArea") == 0) return 1;
    }
    return 0;
}

// 运行时打开 Chromium 系（Chrome / Electron）渲染器可访问性。
// Chrome 默认不把网页内容暴露进 AX 树（只看到浏览器工具栏），必须显式请求。
// 实测：设置私有属性 AXManualAccessibility / AXEnhancedUserInterface 时
// AXUIElementSetAttributeValue 会返回 -25205/-25208（未支持/未实现），
// **但 Chromium 已经因此打开了渲染器可访问性**——所以不能只看返回码，
// 必须重新枚举元素确认 AXWebArea 是否真的出现。
// Safari 本来就暴露网页内容，无需此步。
static void cmdEnableAx(const char *spec) {
    pid_t pid = resolvePid(spec);
    if (pid <= 0) {
        failJson("找不到 app: %s", spec);
        exit(1);
    }
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    const char *attrs[] = {"AXManualAccessibility", "AXEnhancedUserInterface", NULL};

    int rounds = 2;
    for (int r = 0; r < rounds; r++) {
        for (int i = 0; i < 2; i++) {
            CFStringRef attrName = CFStringCreateWithCString(
                NULL, attrs[i], kCFStringEncodingUTF8);
            AXUIElementSetAttributeValue(app, attrName, kCFBooleanTrue);
            CFRelease(attrName);
        }
        // 等渲染器爬起（异步），最多约 3s
        for (int w = 0; w < 20; w++) {
            if (hasWebArea(app)) {
                printf("{\"ok\":true,\"pid\":%d,\"web_area\":true}\n", (int)pid);
                CFRelease(app);
                return;
            }
            usleep(150 * 1000);
        }
    }
    // 非浏览器类 app 本来就没有网页区域，这里如实报告而不是报错
    printf("{\"ok\":false,\"pid\":%d,\"web_area\":false}\n", (int)pid);
    CFRelease(app);
}

// MARK: - 流式查找 / 最优匹配

#define MAXMATCH 64
static Node gMatches[MAXMATCH];
static int gMatchCount = 0;

typedef struct {
    const char *q;
    Node best;
    int bestScore;
    int pressBonus;  // 是否偏好可点击元素（press/click 用）
} BestCtx;

// 收集所有匹配项（供 find 输出列表）
static void visitCollect(Node *n, void *ctxp) {
    const char *q = (const char *)ctxp;
    if (gMatchCount >= MAXMATCH) return;
    if (!isMatch(n, q)) return;
    Node *dst = &gMatches[gMatchCount++];
    *dst = *n;
    dst->el = (uintptr_t)CFRetain((CFTypeRef)n->el);  // 流式遍历会释放，这里要自己留一份
    dst->score = scoreOf(n, q);
}

// 只保留得分最高的一个匹配（供 press / setval / wait-el）
static void visitBest(Node *n, void *ctxp) {
    BestCtx *c = (BestCtx *)ctxp;
    if (!isMatch(n, c->q)) return;
    int sc = scoreOf(n, c->q);
    if (c->pressBonus && n->pressable) sc += 300;
    if (sc > c->bestScore) {
        if (c->bestScore > -1000000) CFRelease((CFTypeRef)c->best.el);
        c->best = *n;
        c->best.el = (uintptr_t)CFRetain((CFTypeRef)n->el);
        c->bestScore = sc;
    }
}

static int findBest(const char *spec, const char *query, int pressBonus, Node *out) {
    BestCtx c;
    memset(&c, 0, sizeof(c));
    c.q = query;
    c.bestScore = -1000000;
    c.pressBonus = pressBonus;
    AXUIElementRef app = appElement(spec, NULL);
    walkRoots(app, 0, visitBest, &c);
    CFRelease(app);
    if (c.bestScore <= -1000000) return 0;
    *out = c.best;
    return 1;
}

// 轮询等待元素出现：替代固定 sleep，既更快也更稳（异步 UI 的常规做法）
static int cmdWaitEl(const char *spec, const char *query, int timeoutMs) {
    int waited = 0;
    const int step = 150;
    Node best;
    for (;;) {
        if (findBest(spec, query, 1, &best)) {
            char er[SBUF * 2], et[LBUF * 2];
            jsonEscape(best.role, er, sizeof(er));
            jsonEscape(nodeText(&best), et, sizeof(et));
            printf("{\"ok\":true,\"waited_ms\":%d,\"role\":\"%s\",\"text\":\"%s\"}\n",
                   waited, er, et);
            CFRelease((CFTypeRef)best.el);
            return 0;
        }
        if (waited >= timeoutMs) {
            return failJson("等待超时 %dms 未见元素: %s", timeoutMs, query);
        }
        usleep(step * 1000);
        waited += step;
    }
}

// MARK: - 输入（CGEvent）
//
// 键鼠全部用 CGEvent 在进程内合成：不需要 nut-js / 任何原生 npm 模块，
// 只需要「辅助功能」权限（CGEventPost 到 kCGHIDEventTap 会被系统按此权限过滤）。

static CGPoint mousePos(void) {
    CGPoint p = CGPointMake(0, 0);
    CGEventRef e = CGEventCreate(NULL);
    if (e) {
        p = CGEventGetLocation(e);
        CFRelease(e);
    }
    return p;
}

static void post(CGEventRef e) {
    if (!e) return;
    CGEventPost(kCGHIDEventTap, e);
    CFRelease(e);
}

// CGWarpMouseCursorPosition 只挪光标、不产生事件；补一条 mouseMoved
// 让 hover / 光标形状 / 「鼠标进入」这类逻辑也能被 app 看到。
static void warpTo(double x, double y) {
    CGPoint p = CGPointMake(x, y);
    CGWarpMouseCursorPosition(p);
    post(CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, p, kCGMouseButtonLeft));
}

static void clickAt(double x, double y, int button, int count) {
    CGEventType downType = button ? kCGEventRightMouseDown : kCGEventLeftMouseDown;
    CGEventType upType = button ? kCGEventRightMouseUp : kCGEventLeftMouseUp;
    CGMouseButton mb = button ? kCGMouseButtonRight : kCGMouseButtonLeft;
    CGPoint p = CGPointMake(x, y);
    for (int i = 1; i <= count; i++) {
        CGEventRef d = CGEventCreateMouseEvent(NULL, downType, p, mb);
        // clickState 是双击 / 三击的唯一识别依据
        if (d) CGEventSetIntegerValueField(d, kCGMouseEventClickState, i);
        post(d);
        usleep(12 * 1000);
        CGEventRef u = CGEventCreateMouseEvent(NULL, upType, p, mb);
        if (u) CGEventSetIntegerValueField(u, kCGMouseEventClickState, i);
        post(u);
        if (i < count) usleep(35 * 1000);
    }
    usleep(20 * 1000);
}

// 拖拽要发中间态 mouseDragged：只发 down/up 会被多数 app 当成点击。
static void dragPath(double x1, double y1, double x2, double y2, int durationMs) {
    if (durationMs < 30) durationMs = 30;
    warpTo(x1, y1);
    usleep(80 * 1000);
    post(CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown,
                                 CGPointMake(x1, y1), kCGMouseButtonLeft));
    int steps = durationMs / 12;
    if (steps < 4) steps = 4;
    for (int i = 1; i <= steps; i++) {
        double t = (double)i / (double)steps;
        CGPoint p = CGPointMake(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
        post(CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDragged, p, kCGMouseButtonLeft));
        usleep(12 * 1000);
    }
    post(CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp,
                                 CGPointMake(x2, y2), kCGMouseButtonLeft));
    usleep(60 * 1000);
}

typedef struct {
    const char *name;
    CGKeyCode code;
    CGEventFlags flag;  // 修饰键对应的 mask；普通键为 0
    int isModifier;
} KeyDef;

// 键名 → ANSI 虚拟键码（与键盘布局无关；输入任意 Unicode 用 type 而不是这里）
static const KeyDef gKeyDefs[] = {
    // 命名键
    {"return", 0x24, 0, 0}, {"enter", 0x24, 0, 0}, {"keypadenter", 0x4C, 0, 0},
    {"tab", 0x30, 0, 0},
    {"esc", 0x35, 0, 0}, {"escape", 0x35, 0, 0},
    {"space", 0x31, 0, 0},
    {"delete", 0x33, 0, 0}, {"backspace", 0x33, 0, 0}, {"bksp", 0x33, 0, 0},
    {"del", 0x75, 0, 0}, {"forwarddelete", 0x75, 0, 0},
    {"up", 0x7E, 0, 0}, {"down", 0x7D, 0, 0},
    {"left", 0x7B, 0, 0}, {"right", 0x7C, 0, 0},
    {"home", 0x73, 0, 0}, {"end", 0x77, 0, 0},
    {"pageup", 0x74, 0, 0}, {"pagedown", 0x79, 0, 0},
    {"f1", 0x7A, 0, 0}, {"f2", 0x78, 0, 0}, {"f3", 0x63, 0, 0}, {"f4", 0x76, 0, 0},
    {"f5", 0x60, 0, 0}, {"f6", 0x61, 0, 0}, {"f7", 0x62, 0, 0}, {"f8", 0x64, 0, 0},
    {"f9", 0x65, 0, 0}, {"f10", 0x6D, 0, 0}, {"f11", 0x67, 0, 0}, {"f12", 0x6F, 0, 0},
    // 修饰键
    {"cmd", 0x37, kCGEventFlagMaskCommand, 1},
    {"command", 0x37, kCGEventFlagMaskCommand, 1},
    {"super", 0x37, kCGEventFlagMaskCommand, 1},
    {"meta", 0x37, kCGEventFlagMaskCommand, 1},
    {"shift", 0x38, kCGEventFlagMaskShift, 1},
    {"alt", 0x3A, kCGEventFlagMaskAlternate, 1},
    {"option", 0x3A, kCGEventFlagMaskAlternate, 1},
    {"opt", 0x3A, kCGEventFlagMaskAlternate, 1},
    {"ctrl", 0x3B, kCGEventFlagMaskControl, 1},
    {"control", 0x3B, kCGEventFlagMaskControl, 1},
    {"capslock", 0x39, kCGEventFlagMaskAlphaShift, 1},
    // 字符键（按 ANSI 位置；需要大写/符号时用 press 显式带 shift）
    {"a", 0x00, 0, 0}, {"s", 0x01, 0, 0}, {"d", 0x02, 0, 0}, {"f", 0x03, 0, 0},
    {"h", 0x04, 0, 0}, {"g", 0x05, 0, 0}, {"z", 0x06, 0, 0}, {"x", 0x07, 0, 0},
    {"c", 0x08, 0, 0}, {"v", 0x09, 0, 0}, {"b", 0x0B, 0, 0}, {"q", 0x0C, 0, 0},
    {"w", 0x0D, 0, 0}, {"e", 0x0E, 0, 0}, {"r", 0x0F, 0, 0}, {"y", 0x10, 0, 0},
    {"t", 0x11, 0, 0}, {"1", 0x12, 0, 0}, {"2", 0x13, 0, 0}, {"3", 0x14, 0, 0},
    {"4", 0x15, 0, 0}, {"6", 0x16, 0, 0}, {"5", 0x17, 0, 0}, {"9", 0x19, 0, 0},
    {"7", 0x1A, 0, 0}, {"8", 0x1C, 0, 0}, {"0", 0x1D, 0, 0}, {"o", 0x1F, 0, 0},
    {"u", 0x20, 0, 0}, {"i", 0x22, 0, 0}, {"p", 0x23, 0, 0}, {"l", 0x25, 0, 0},
    {"j", 0x26, 0, 0}, {"k", 0x28, 0, 0}, {"n", 0x2D, 0, 0}, {"m", 0x2E, 0, 0},
    // 符号键
    {"equal", 0x18, 0, 0}, {"plus", 0x18, 0, 0},
    {"minus", 0x1B, 0, 0},
    {"rightbracket", 0x1E, 0, 0},
    {"leftbracket", 0x21, 0, 0},
    {"quote", 0x27, 0, 0},
    {"semicolon", 0x29, 0, 0},
    {"backslash", 0x2A, 0, 0},
    {"comma", 0x2B, 0, 0},
    {"slash", 0x2C, 0, 0},
    {"period", 0x2F, 0, 0}, {"dot", 0x2F, 0, 0},
    {"grave", 0x32, 0, 0}, {"backtick", 0x32, 0, 0},
    {NULL, 0, 0, 0}
};

static const KeyDef *findKey(const char *name) {
    char n[64];
    size_t i;
    for (i = 0; name[i] && i < sizeof(n) - 1; i++) n[i] = (char)tolower((unsigned char)name[i]);
    n[i] = 0;
    for (int k = 0; gKeyDefs[k].name; k++) {
        if (strcmp(gKeyDefs[k].name, n) == 0) return &gKeyDefs[k];
    }
    return NULL;
}

static void postKey(CGKeyCode code, int down, CGEventFlags flags) {
    CGEventRef e = CGEventCreateKeyboardEvent(NULL, code, down ? true : false);
    if (!e) return;
    if (flags) CGEventSetFlags(e, flags);
    CGEventPost(kCGHIDEventTap, e);
    CFRelease(e);
}

// 修饰键状态必须走 flagsChanged：发 keyDown/keyUp 时窗口服务器不会更新修饰位
static void postFlags(CGKeyCode code, CGEventFlags flags) {
    CGEventRef e = CGEventCreateKeyboardEvent(NULL, code, true);
    if (!e) return;
    CGEventSetType(e, kCGEventFlagsChanged);
    CGEventSetFlags(e, flags);
    CGEventPost(kCGHIDEventTap, e);
    CFRelease(e);
}

static int cmdMove(double x, double y) {
    warpTo(x, y);
    usleep(60 * 1000);
    CGPoint after = mousePos();
    printf("{\"ok\":true,\"x\":%.1f,\"y\":%.1f}\n", after.x, after.y);
    return 0;
}

static int cmdPos(void) {
    CGPoint p = mousePos();
    printf("{\"ok\":true,\"x\":%.1f,\"y\":%.1f}\n", p.x, p.y);
    return 0;
}

// 逻辑点（CGEvent 坐标口径）；pixel* 才是截图 / Retina 2x 口径
static int cmdSize(void) {
    CGRect b = CGDisplayBounds(CGMainDisplayID());
    size_t pw = CGDisplayPixelsWide(CGMainDisplayID());
    size_t ph = CGDisplayPixelsHigh(CGMainDisplayID());
    printf("{\"ok\":true,\"width\":%.0f,\"height\":%.0f,\"pixelWidth\":%zu,\"pixelHeight\":%zu}\n",
           b.size.width, b.size.height, pw, ph);
    return 0;
}

static int cmdClick(int hasXY, double x, double y, int button, int count) {
    if (hasXY) {
        warpTo(x, y);
        usleep(120 * 1000);
    }
    CGPoint at = mousePos();
    clickAt(at.x, at.y, button, count);
    printf("{\"ok\":true,\"x\":%.1f,\"y\":%.1f,\"button\":\"%s\",\"count\":%d}\n",
           at.x, at.y, button ? "right" : "left", count);
    return 0;
}

static int cmdDrag(double x1, double y1, double x2, double y2, int durationMs) {
    dragPath(x1, y1, x2, y2, durationMs);
    CGPoint after = mousePos();
    printf("{\"ok\":true,\"from\":{\"x\":%.1f,\"y\":%.1f},\"to\":{\"x\":%.1f,\"y\":%.1f},"
           "\"x\":%.1f,\"y\":%.1f}\n",
           x1, y1, x2, y2, after.x, after.y);
    return 0;
}

// dy > 0 = 向上滚（内容下移）；dx > 0 = 向左滚。与 NSEvent deltaY 同号。
static int cmdScroll(int dy, int dx) {
    CGEventRef e = CGEventCreateScrollWheelEvent(
        NULL, kCGScrollEventUnitLine, 2, (int32_t)dy, (int32_t)dx);
    if (!e) return failJson("创建滚轮事件失败");
    CGEventPost(kCGHIDEventTap, e);
    CFRelease(e);
    usleep(20 * 1000);
    printf("{\"ok\":true,\"dy\":%d,\"dx\":%d}\n", dy, dx);
    return 0;
}

// 整串一次发出：CGEventKeyboardSetUnicodeString 支持任意 Unicode，
// 不依赖键盘布局（按 keycode 拼 ASCII 在非美式布局下会打错字）。
static int cmdType(const char *utf8) {
    size_t len = strlen(utf8);
    if (len == 0) return failJson("type 需要非空文本");
    CFStringRef s = CFStringCreateWithBytes(
        NULL, (const UInt8 *)utf8, (CFIndex)len, kCFStringEncodingUTF8, false);
    if (!s) return failJson("type 的文本不是合法 UTF-8");
    CFIndex n = CFStringGetLength(s);
    UniChar *chars = (UniChar *)malloc(sizeof(UniChar) * ((size_t)n + 1));
    if (!chars) { CFRelease(s); return failJson("内存不足"); }
    CFStringGetCharacters(s, CFRangeMake(0, n), chars);
    CFRelease(s);

    CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true);
    if (down) {
        CGEventKeyboardSetUnicodeString(down, (UniCharCount)n, chars);
        CGEventPost(kCGHIDEventTap, down);
        CFRelease(down);
    }
    CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
    if (up) {
        CGEventKeyboardSetUnicodeString(up, (UniCharCount)n, chars);
        CGEventPost(kCGHIDEventTap, up);
        CFRelease(up);
    }
    free(chars);
    usleep(30 * 1000);
    printf("{\"ok\":true,\"chars\":%d}\n", (int)n);
    return 0;
}

static int cmdKey(const char *name) {
    const KeyDef *k = findKey(name);
    if (!k) return failJson("未知键名: %s", name);
    if (k->isModifier) {
        postFlags(k->code, k->flag);
        usleep(20 * 1000);
        postFlags(k->code, 0);
    } else {
        postKey(k->code, 1, 0);
        usleep(15 * 1000);
        postKey(k->code, 0, 0);
    }
    // CGEventPost 是异步的：进程立刻退出会丢掉还没送达的事件
    usleep(30 * 1000);
    printf("{\"ok\":true,\"key\":\"%s\",\"code\":%d}\n", name, (int)k->code);
    return 0;
}

// "shift+cmd+4" → 按住修饰键、敲主键、逆序释放
static int cmdChord(const char *spec) {
    char buf[256];
    if (strlen(spec) >= sizeof(buf)) return failJson("组合键过长: %s", spec);
    snprintf(buf, sizeof(buf), "%s", spec);

    char *parts[8];
    int np = 0;
    char *p = buf;
    while (p && *p && np < 8) {
        char *plus = strchr(p, '+');
        if (plus) *plus = 0;
        while (*p == ' ') p++;
        char *end = p + strlen(p);
        while (end > p && end[-1] == ' ') *--end = 0;
        if (*p) parts[np++] = p;
        p = plus ? plus + 1 : NULL;
    }
    if (np == 0) return failJson("组合键为空");

    const KeyDef *defs[8];
    for (int i = 0; i < np; i++) {
        defs[i] = findKey(parts[i]);
        if (!defs[i]) return failJson("未知键名: %s（来自 %s）", parts[i], spec);
    }

    const KeyDef *mainKey = defs[np - 1];
    CGEventFlags flags = 0;
    for (int i = 0; i < np - 1; i++) {
        if (!defs[i]->isModifier) {
            return failJson("%s 不是修饰键（组合键里除最后一个都必须是 cmd/shift/alt/ctrl）",
                            parts[i]);
        }
        flags |= defs[i]->flag;
        postFlags(defs[i]->code, flags);
        usleep(12 * 1000);
    }

    if (mainKey->isModifier) {
        // 只按修饰键：按下再抬起，别留下粘滞状态
        postFlags(mainKey->code, flags | mainKey->flag);
        usleep(20 * 1000);
        postFlags(mainKey->code, flags);
    } else {
        postKey(mainKey->code, 1, flags);
        usleep(20 * 1000);
        postKey(mainKey->code, 0, flags);
    }

    for (int i = np - 2; i >= 0; i--) {
        flags = flags & ~defs[i]->flag;
        postFlags(defs[i]->code, flags);
        usleep(12 * 1000);
    }
    // 同上：等最后一批事件送达再退出，否则组合键会偶发「什么都没发生」
    usleep(30 * 1000);
    printf("{\"ok\":true,\"chord\":\"%s\"}\n", spec);
    return 0;
}

// MARK: - 权限自检

// 老 SDK 没有这个符号：弱链接后为 NULL，再用一次 1x1 截图探测兜底。
extern bool CGPreflightScreenCaptureAccess(void) __attribute__((weak_import));

static int screenRecordingGranted(void) {
    if (CGPreflightScreenCaptureAccess) {
        return CGPreflightScreenCaptureAccess() ? 1 : 0;
    }
    // macOS 10.15 之前的系统没有这个 API，也没有别的公开探测方式
    // （CGWindowListCreateImage 在 macOS 15 SDK 已 obsoleted，不能用来兜底）。
    fprintf(stderr, "note: 本系统没有 CGPreflightScreenCaptureAccess，屏幕录制状态按未授权报告\n");
    return 0;
}

// 只报 AX / 屏幕录制两项：clang / CLT 由 desktop.mjs 检查（那属于运行时环境，不是权限）
static int cmdCheck(void) {
    int ax = AXIsProcessTrusted() ? 1 : 0;
    int sr = screenRecordingGranted();
    printf("{\"accessibility\":%s,\"screenRecording\":%s}\n",
           ax ? "true" : "false", sr ? "true" : "false");
    return 0;
}

// MARK: - 参数

typedef struct {
    const char *pos[8];
    int npos;
    int maxDepth;
    int limit;
    int menus;      // -1 = 按命令自动
    int timeoutMs;
    int button;     // 0 = left, 1 = right
    int count;
    int durationMs;
} Opts;

static Opts parseArgs(int argc, char **argv) {
    Opts o;
    memset(&o, 0, sizeof(o));
    o.maxDepth = 24;
    o.limit = MAXNODES;
    o.menus = -1;
    o.timeoutMs = 5000;
    o.button = 0;
    o.count = 1;
    o.durationMs = 300;

    for (int i = 2; i < argc; i++) {
        const char *a = argv[i];
        if (strcmp(a, "--depth") == 0 && i + 1 < argc) {
            o.maxDepth = atoi(argv[++i]);
        } else if (strcmp(a, "--limit") == 0 && i + 1 < argc) {
            o.limit = atoi(argv[++i]);
            if (o.limit <= 0 || o.limit > MAXNODES) o.limit = MAXNODES;
        } else if (strcmp(a, "--menus") == 0) {
            o.menus = 1;
        } else if (strcmp(a, "--no-menus") == 0) {
            o.menus = 0;
        } else if (strcmp(a, "--timeout") == 0 && i + 1 < argc) {
            o.timeoutMs = atoi(argv[++i]);
            if (o.timeoutMs <= 0) o.timeoutMs = 5000;
        } else if (strcmp(a, "--button") == 0 && i + 1 < argc) {
            o.button = strcmp(argv[++i], "right") == 0 ? 1 : 0;
        } else if (strcmp(a, "--count") == 0 && i + 1 < argc) {
            o.count = atoi(argv[++i]);
            if (o.count < 1) o.count = 1;
            if (o.count > 3) o.count = 3;
        } else if (strcmp(a, "--duration") == 0 && i + 1 < argc) {
            o.durationMs = atoi(argv[++i]);
            if (o.durationMs < 0) o.durationMs = 0;
        } else if (strcmp(a, "--json") == 0) {
            // 恒输出 JSON，接受 --json 只为兼容既有调用
        } else if (o.npos < 8) {
            o.pos[o.npos++] = a;
        }
    }
    return o;
}

static void usage(void) {
    printf("{\"usage\":\"helper <command> [args]\",\"commands\":["
           "\"apps\",\"frontmost\",\"windows <app>\","
           "\"tree <app> [--depth N] [--limit N] [--menus]\","
           "\"find <app> <query> [--menus]\","
           "\"press <app> <query> [--menus] | press <mod+key>\","
           "\"chord <mod+key>\",\"setval <app> <query> <value>\","
           "\"focus <app>\",\"webtext <app>\",\"enable-ax <app>\","
           "\"wait-el <app> <q> [--timeout ms]\","
           "\"move <x> <y>\",\"pos\",\"size\","
           "\"click [x y] [--button left|right] [--count N]\","
           "\"drag <x1> <y1> <x2> <y2> [--duration ms]\","
           "\"scroll <dy> [dx]\",\"type <text>\",\"key <name>\",\"check\"]}\n");
}

int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc < 2) { usage(); return 0; }

        Opts o = parseArgs(argc, argv);
        gMaxDepth = o.maxDepth;
        gLimit = o.limit;
        gMenus = o.menus;
        gTimeoutMs = o.timeoutMs;

        const char *cmd = argv[1];

        if (strcmp(cmd, "check") == 0) {
            return cmdCheck();
        }
        // --- 输入 ---
        if (strcmp(cmd, "pos") == 0) {
            return cmdPos();
        }
        if (strcmp(cmd, "size") == 0) {
            return cmdSize();
        }
        if (strcmp(cmd, "move") == 0) {
            if (o.npos < 2) return failJson("用法 move <x> <y>");
            return cmdMove(atof(o.pos[0]), atof(o.pos[1]));
        }
        if (strcmp(cmd, "click") == 0) {
            int hasXY = o.npos >= 2;
            double x = hasXY ? atof(o.pos[0]) : 0;
            double y = hasXY ? atof(o.pos[1]) : 0;
            return cmdClick(hasXY, x, y, o.button, o.count);
        }
        if (strcmp(cmd, "drag") == 0) {
            if (o.npos < 4) return failJson("用法 drag <x1> <y1> <x2> <y2> [--duration ms]");
            return cmdDrag(atof(o.pos[0]), atof(o.pos[1]), atof(o.pos[2]), atof(o.pos[3]),
                           o.durationMs);
        }
        if (strcmp(cmd, "scroll") == 0) {
            if (o.npos < 1) return failJson("用法 scroll <dy> [dx]");
            int dy = atoi(o.pos[0]);
            int dx = o.npos >= 2 ? atoi(o.pos[1]) : 0;
            return cmdScroll(dy, dx);
        }
        if (strcmp(cmd, "type") == 0) {
            if (o.npos < 1) return failJson("用法 type <text>");
            return cmdType(o.pos[0]);
        }
        if (strcmp(cmd, "key") == 0) {
            if (o.npos < 1) return failJson("用法 key <name>");
            return cmdKey(o.pos[0]);
        }
        if (strcmp(cmd, "chord") == 0) {
            if (o.npos < 1) return failJson("用法 chord <mod+key>");
            return cmdChord(o.pos[0]);
        }

        // --- AX ---
        if (strcmp(cmd, "apps") == 0) {
            cmdApps();
            return 0;
        }
        if (strcmp(cmd, "frontmost") == 0) {
            cmdFrontmost();
            return 0;
        }
        if (strcmp(cmd, "windows") == 0) {
            if (o.npos < 1) return failJson("需要 app|pid");
            return cmdWindows(o.pos[0]);
        }
        if (strcmp(cmd, "tree") == 0) {
            if (o.npos < 1) return failJson("需要 app|pid");
            AXUIElementRef app = appElement(o.pos[0], NULL);
            gTruncated = 0;
            collectRoots(app, 0);
            printf("[");
            for (int i = 0; i < gCount; i++) printNodeJSON(&gNodes[i], i == gCount - 1);
            printf("]\n");
            // 真实页面经常超过上限：明确告知，避免把「截断的树」当成完整结果
            if (gTruncated) {
                fprintf(stderr,
                    "note: 树已被截断（%d 节点 / 深度 %d 上限）。"
                    "find / webtext 走流式遍历不受此限；需要完整树时用 --limit / --depth 调大。\n",
                    gCount, gMaxDepth);
            }
            CFRelease(app);
            return 0;
        }
        if (strcmp(cmd, "find") == 0) {
            if (o.npos < 2) return failJson("用法 find <app|pid> <query>");
            AXUIElementRef app = appElement(o.pos[0], NULL);
            gMatchCount = 0;
            walkRoots(app, 0, visitCollect, (void *)o.pos[1]);
            // 按命中分降序（插件匹配项优先）
            for (int a = 0; a < gMatchCount; a++) {
                for (int b = a + 1; b < gMatchCount; b++) {
                    if (gMatches[b].score > gMatches[a].score) {
                        Node t = gMatches[a]; gMatches[a] = gMatches[b]; gMatches[b] = t;
                    }
                }
            }
            if (gMatchCount > 30) gMatchCount = 30;
            printf("[");
            for (int a = 0; a < gMatchCount; a++) printNodeJSON(&gMatches[a], a == gMatchCount - 1);
            printf("]\n");
            CFRelease(app);
            return 0;
        }
        // press 一名两用：1 个参数是组合键，2 个及以上是 AXPress（老脚本的写法）
        if (strcmp(cmd, "press") == 0) {
            if (o.npos == 1) return cmdChord(o.pos[0]);
            if (o.npos < 2) return failJson("用法 press <app|pid> <query> 或 press <mod+key>");
            AXUIElementRef app = appElement(o.pos[0], NULL);
            BestCtx bc;
            memset(&bc, 0, sizeof(bc));
            bc.q = o.pos[1];
            bc.pressBonus = 1;
            bc.bestScore = -1000000;
            walkRoots(app, 0, visitBest, &bc);
            if (bc.bestScore <= -1000000) {
                CFRelease(app);
                return failJson("找不到元素: %s", o.pos[1]);
            }
            AXUIElementRef el = (AXUIElementRef)bc.best.el;
            AXError err = AXUIElementPerformAction(el, kAXPressAction);
            if (err != kAXErrorSuccess) {
                CFRelease((CFTypeRef)bc.best.el);
                CFRelease(app);
                return failJson("AXPress 失败 code=%d", (int)err);
            }
            Node *n = &bc.best;
            char er[SBUF * 2], et[LBUF * 2];
            jsonEscape(n->role, er, sizeof(er));
            jsonEscape(n->title, et, sizeof(et));
            printf("{\"ok\":true,\"role\":\"%s\",\"title\":\"%s\",\"cx\":%.1f,\"cy\":%.1f}\n",
                   er, et, n->x + n->w / 2, n->y + n->h / 2);
            CFRelease((CFTypeRef)bc.best.el);
            CFRelease(app);
            return 0;
        }
        if (strcmp(cmd, "setval") == 0) {
            if (o.npos < 3) return failJson("用法 setval <app|pid> <query> <value>");
            Node best;
            if (!findBest(o.pos[0], o.pos[1], 0, &best)) {
                return failJson("找不到元素: %s", o.pos[1]);
            }
            CFStringRef val = CFStringCreateWithCString(NULL, o.pos[2], kCFStringEncodingUTF8);
            AXError err = AXUIElementSetAttributeValue(
                (AXUIElementRef)best.el, kAXValueAttribute, val);
            CFRelease(val);
            if (err != kAXErrorSuccess) {
                CFRelease((CFTypeRef)best.el);
                return failJson("设置 value 失败 code=%d", (int)err);
            }
            char er[SBUF * 2], et[LBUF * 2], ev[LBUF * 2];
            jsonEscape(best.role, er, sizeof(er));
            jsonEscape(best.title, et, sizeof(et));
            jsonEscape(o.pos[2], ev, sizeof(ev));
            printf("{\"ok\":true,\"role\":\"%s\",\"title\":\"%s\",\"value\":\"%s\"}\n", er, et, ev);
            CFRelease((CFTypeRef)best.el);
            return 0;
        }
        if (strcmp(cmd, "focus") == 0) {
            if (o.npos < 1) return failJson("需要 app|pid");
            pid_t pid = resolvePid(o.pos[0]);
            if (pid <= 0) return failJson("找不到 app: %s", o.pos[0]);
            AXUIElementRef app = AXUIElementCreateApplication(pid);
            AXError err = AXUIElementSetAttributeValue(app, kAXFrontmostAttribute, kCFBooleanTrue);
            printf("{\"ok\":%s,\"pid\":%d,\"code\":%d}\n",
                   err == kAXErrorSuccess ? "true" : "false", (int)pid, (int)err);
            CFRelease(app);
            return err == kAXErrorSuccess ? 0 : 1;
        }
        if (strcmp(cmd, "webtext") == 0) {
            if (o.npos < 1) return failJson("需要 app|pid");
            cmdWebtext(o.pos[0]);
            return 0;
        }
        if (strcmp(cmd, "enable-ax") == 0) {
            if (o.npos < 1) return failJson("需要 app|pid");
            cmdEnableAx(o.pos[0]);
            return 0;
        }
        if (strcmp(cmd, "wait-el") == 0) {
            if (o.npos < 2) return failJson("用法 wait-el <app|pid> <query> [--timeout ms]");
            return cmdWaitEl(o.pos[0], o.pos[1], gTimeoutMs);
        }

        return failJson("未知命令 %s（用 helper 不带参数看命令表）", cmd);
    }
}
