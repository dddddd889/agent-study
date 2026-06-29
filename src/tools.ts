import type { Tool } from "./types";

// 一组演示用的内置工具。每个工具都遵循 Tool 接口：
// 给模型看的「说明书」(name/description/inputSchema) + 本地执行逻辑 (run)。

// 工具 1：返回当前日期时间。
// 模型本身不知道“现在几点”，这类实时信息正适合用工具补足。
export const getCurrentTime: Tool = {
  name: "get_current_time",
  description:
    "获取当前的日期和时间（ISO 8601 字符串）。当用户问“现在几点 / 今天几号”等实时信息时使用。",
  inputSchema: { type: "object", properties: {} },
  run() {
    return new Date().toISOString();
  },
};

// 工具 2：四则运算计算器。
// 模型做大数或多步算术容易出错，交给确定性的代码更可靠。
export const calculator: Tool = {
  name: "calculator",
  description: '计算一个数学表达式，例如 "(3 + 4) * 5"。需要做算术时使用。',
  inputSchema: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "要计算的数学表达式，只含数字和 + - * / ( ) 运算符",
      },
    },
    required: ["expression"],
  },
  run(input) {
    const expr = String(input.expression ?? "");
    // 安全起见：只允许数字、运算符、小数点、括号和空格，杜绝任意代码执行。
    if (!/^[\d+\-*/().\s]+$/.test(expr)) {
      throw new Error(`表达式包含非法字符: ${expr}`);
    }
    // 在受限字符集前提下求值；仅用于学习演示。
    const value = Function(`"use strict"; return (${expr});`)();
    return String(value);
  },
};

// 默认工具集：CLI 直接用这一组。
export const defaultTools: Tool[] = [getCurrentTime, calculator];
