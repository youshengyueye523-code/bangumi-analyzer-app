/**
 * jsdom 环境补齐：只提供组件测试真正用到的浏览器 API，
 * 不做过度 mock，避免测试与实际运行环境产生偏差。
 */
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// vitest 未启用 globals，因此显式注册 DOM 清理，避免测试之间互相污染
afterEach(() => {
  cleanup();
});

if (!('matchMedia' in window)) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

if (!('ResizeObserver' in window)) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(window, 'ResizeObserver', { writable: true, value: ResizeObserverStub });
}

if (!('IntersectionObserver' in window)) {
  class IntersectionObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  }
  Object.defineProperty(window, 'IntersectionObserver', {
    writable: true,
    value: IntersectionObserverStub,
  });
}

// jsdom 未实现指针捕获：背景板预览的拖动会用到，这里补上空实现
if (!('setPointerCapture' in window.Element.prototype)) {
  Object.defineProperty(window.Element.prototype, 'setPointerCapture', {
    writable: true,
    value: () => undefined,
  });
  Object.defineProperty(window.Element.prototype, 'releasePointerCapture', {
    writable: true,
    value: () => undefined,
  });
}

window.HTMLElement.prototype.scrollIntoView = () => undefined;
