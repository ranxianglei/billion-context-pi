[English](./omp.md) | [中文](./omp.zh-CN.md)

# OMP(oh-my-pi)支持

> **billion-context-pi 不支持 OMP。** 在 OMP(`can1357/oh-my-pi`)宿主上运行时,
> 扩展会**拒绝服务**:打印一次警告、禁用 ACP 工具,并保持宿主自身的上下文处理
> 不受影响。请改用 [billion-context](https://github.com/ranxianglei/billion-context)
> 代理。

## 为什么不支持 OMP

billion-context-pi 是面向 **Pi** 编码代理(`@earendil-works/pi-coding-agent`)的
进程内适配器。它通过向实时对话注入不可见的消息引用(`m00001`、`m00002` …),
让模型基于这些引用驱动 `compress` / `decompress` / `search_context` 来管理上下文。

OMP 暴露的是另一套进程内会话 API。扩展注入的引用可能与会话的真实引用发生漂移,
导致 `compress` 调用失败,报错 `does not exist in this session`,一次性运行
(one-shot)永远无法成功
([#234](https://github.com/ranxianglei/billion-context-pi/issues/234))。在 OMP 上
维持这套进程内集成的可靠性并不划算,因此 OMP 不再是本插件主动支持的宿主。

## 在 OMP 宿主上会发生什么

会话开始时,扩展通过特性检测识别宿主(Pi 暴露
`sessionManager.buildContextEntries()`,OMP 只暴露 `getBranch()`)。任何缺少该 API 的宿主
都会被"让位",除非它通过 `PI_ACP_FORK_HOST=1` 声明自己是兼容 Pi 的 fork(见
[host-adapter.md](./host-adapter.md))——该声明面向 `getBranch()` 符合上述契约的 fork,
不适用于 OMP,因此 OMP 始终"让位":

- **每个进程只警告一次**(TUI/RPC 下用 UI 通知;headless 一次性模式下用
  `console.error` 输出到 stderr),并指向受支持的替代方案;
- 四个 ACP 工具(`compress`、`decompress`、`search_context`、`acp_status`)
  返回引导信息,而不执行实际操作;
- 跳过 ACP 系统提示注入;
- `context` 转换变为空操作(消息原样透传);
- **不**取消宿主自身的自动压缩。

Pi 宿主完全不受影响。

## 替代方案:billion-context 代理

[billion-context](https://github.com/ranxianglei/billion-context) 把同样的压缩
流水线**运行在服务端代理**里。由于代理持有引用坐标系,引用不会漂移 —— 因此它
在 OMP(以及其他宿主)上都能工作。

```bash
npm install -g billion-context
bili omp
```

`bili omp` 会启动一个本地代理,并让 OMP 通过它运行。更多选项见
[billion-context](https://github.com/ranxianglei/billion-context)。
