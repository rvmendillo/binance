import SwiftUI
import UIKit
import UniformTypeIdentifiers
import WebKit

/// Native shell for the Confluence simulator. The whole app is one bundled web page
/// (built from the repository's src/ by `npm run build`) shown in a WKWebView.
/// It is served from a custom app:// scheme so the page gets a stable origin for
/// local storage, IndexedDB and Web Workers, and can call Binance's public market-data
/// API (which allows any origin). The app never places orders and stores no API keys.
@main
struct ConfluenceApp: App {
    var body: some Scene {
        WindowGroup {
            WebAppView()
                .ignoresSafeArea()
                .background(Color("LaunchBackground").ignoresSafeArea())
        }
    }
}

/// Serves files from the app bundle's `www` folder for app://localhost/... URLs.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "app"
    private let root: URL

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let fileURL = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        // never serve anything outside the bundled www folder
        guard fileURL.path.hasPrefix(root.path), let data = try? Data(contentsOf: fileURL) else {
            let notFound = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain"])!
            urlSchemeTask.didReceive(notFound)
            urlSchemeTask.didReceive(Data("Not found".utf8))
            urlSchemeTask.didFinish()
            return
        }
        let mime = UTType(filenameExtension: fileURL.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let headers = [
            "Content-Type": mime.hasPrefix("text/") ? "\(mime); charset=utf-8" : mime,
            "Content-Length": String(data.count),
            "Cache-Control": "no-cache",
        ]
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

struct WebAppView: UIViewRepresentable {
    static let startURL = URL(string: "\(BundleSchemeHandler.scheme)://localhost/index.html")!

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let root = Bundle.main.resourceURL!.appendingPathComponent("www", isDirectory: true)
        config.setURLSchemeHandler(BundleSchemeHandler(root: root), forURLScheme: BundleSchemeHandler.scheme)
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = UIColor(named: "LaunchBackground")
        webView.scrollView.backgroundColor = UIColor(named: "LaunchBackground")
        // the page applies the safe-area insets itself (viewport-fit=cover)
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        webView.load(URLRequest(url: Self.startURL))
        context.coordinator.observeForeground(webView)
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        private var foregroundObserver: NSObjectProtocol?

        deinit {
            if let o = foregroundObserver { NotificationCenter.default.removeObserver(o) }
        }

        /// Tell the page when the app returns to the foreground so it can fetch the
        /// candles it missed while suspended.
        func observeForeground(_ webView: WKWebView) {
            foregroundObserver = NotificationCenter.default.addObserver(
                forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
            ) { [weak webView] _ in
                webView?.evaluateJavaScript("window.__confluence && window.__confluence.repairAll(true)", completionHandler: nil)
            }
        }

        /// Links to other websites open in Safari instead of replacing the app.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if let url = navigationAction.request.url, let scheme = url.scheme?.lowercased(),
               scheme == "http" || scheme == "https", navigationAction.targetFrame?.isMainFrame ?? true {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url { UIApplication.shared.open(url) }
            return nil
        }

        /// iOS may kill the web content process under memory pressure: reload it.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.load(URLRequest(url: WebAppView.startURL))
        }
    }
}
