// cfyxip：Cloudflare 优选 IP 扫描器（luci-app-cfyxip 的核心程序）
//
// 流程：抽样 IP → TCP 延迟/丢包 → 真实 HTTPS 验证（校验证书 + /cdn-cgi/trace 拿机房）→ 按落地国家/机房过滤
//       → 测速 → 多轮复验 → 排序取前 N 个 → 写 xyip.txt / result.json → 可选推送到 GitHub
//
// 用法：cfyxip scan [-c uci文件或 show 输出]   cfyxip push   cfyxip colos
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var Version = "dev"

//go:embed colo.json
var coloJSON []byte

var colos map[string][3]string // IATA -> [国家代码, 国家中文, 城市]

// Cloudflare 官方 IPv4 段（https://www.cloudflare.com/ips-v4）
var cfV4 = []string{
	"173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
	"108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
	"162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
}

var (
	DataDir = "/etc/cfyxip"
	RunDir  = "/tmp/cfyxip"
)

// ---------------------------------------------------------------- 配置
type Config struct {
	Ports        []int
	Sample       int
	Threads      int
	TCPTries     int
	MaxLatency   int // ms
	Countries    map[string]bool
	Colos        map[string]bool
	ValidateHost string
	ValidatePath string
	SpeedTest    bool
	SpeedHost    string
	SpeedBytes   int
	SpeedSeconds int
	MinSpeed     float64 // MB/s
	Count        int
	Recheck      int
	KeepOld      bool
	ExtraIPs     []string
	Remark       string
	Push         bool
	GhToken      string
	GhRepo       string
	GhBranch     string
	GhPath       string
}

func parseUCI(text string) map[string][]string {
	m := map[string][]string{}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		i := strings.Index(line, "=")
		if i < 0 || !strings.HasPrefix(line, "cfyxip.main.") {
			continue
		}
		k := strings.TrimPrefix(line[:i], "cfyxip.main.")
		m[k] = splitUCIValues(line[i+1:])
	}
	return m
}

func splitUCIValues(v string) []string {
	var out []string
	var cur strings.Builder
	inq := false
	for _, r := range v {
		switch {
		case r == '\'':
			inq = !inq
		case r == ' ' && !inq:
			if cur.Len() > 0 {
				out = append(out, cur.String())
				cur.Reset()
			}
		default:
			cur.WriteRune(r)
		}
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}

func loadConfig(src string) *Config {
	var text string
	if src != "" {
		b, _ := os.ReadFile(src)
		text = string(b)
	} else {
		b, _ := exec.Command("uci", "-q", "show", "cfyxip.main").Output()
		text = string(b)
	}
	m := parseUCI(text)
	s := func(k, d string) string {
		if v := m[k]; len(v) > 0 && strings.TrimSpace(strings.Join(v, " ")) != "" {
			return strings.TrimSpace(strings.Join(v, " "))
		}
		return d
	}
	n := func(k string, d, lo, hi int) int {
		x, err := strconv.Atoi(s(k, ""))
		if err != nil {
			return d
		}
		if x < lo {
			x = lo
		}
		if x > hi {
			x = hi
		}
		return x
	}
	list := func(k string) []string {
		var out []string
		for _, v := range m[k] {
			for _, f := range strings.FieldsFunc(v, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' || r == ';' }) {
				if f = strings.TrimSpace(f); f != "" {
					out = append(out, f)
				}
			}
		}
		return out
	}
	c := &Config{
		Sample: n("sample", 4000, 100, 100000), Threads: n("threads", 200, 1, 1000), TCPTries: n("tcp_tries", 3, 1, 10),
		MaxLatency: n("max_latency", 300, 20, 2000), ValidateHost: s("validate_host", "speed.cloudflare.com"),
		ValidatePath: s("validate_path", "/cdn-cgi/trace"), SpeedTest: s("speed_test", "1") == "1",
		SpeedHost: s("speed_host", "speed.cloudflare.com"), SpeedBytes: n("speed_mb", 50, 1, 500) * 1000 * 1000,
		SpeedSeconds: n("speed_seconds", 8, 3, 60), Count: n("count", 10, 1, 200), Recheck: n("recheck", 3, 0, 10),
		KeepOld: s("keep_old", "1") == "1", Remark: s("remark", "{colo} {speed}MB/s {latency}ms"),
		Push: s("push", "0") == "1", GhToken: s("gh_token", ""), GhRepo: s("gh_repo", ""),
		GhBranch: s("gh_branch", "main"), GhPath: s("gh_path", "xyip.txt"),
		Countries: map[string]bool{}, Colos: map[string]bool{}, ExtraIPs: list("extra_ips"),
	}
	c.MinSpeed, _ = strconv.ParseFloat(s("min_speed", "1"), 64)
	for _, p := range list("ports") {
		if x, err := strconv.Atoi(p); err == nil && x > 0 && x < 65536 {
			c.Ports = append(c.Ports, x)
		}
	}
	if len(c.Ports) == 0 {
		c.Ports = []int{443}
	}
	for _, x := range list("countries") {
		c.Countries[strings.ToUpper(x)] = true
	}
	for _, x := range list("colos") {
		c.Colos[strings.ToUpper(x)] = true
	}
	if c.GhToken == "" { // 没单独填就复用 AI 运维助手里的 GitHub 令牌
		b, _ := exec.Command("uci", "-q", "get", "opsagent.main.github_token").Output()
		c.GhToken = strings.TrimSpace(string(b))
	}
	return c
}

// ---------------------------------------------------------------- 结果
type Result struct {
	IP       string  `json:"ip"`
	Port     int     `json:"port"`
	Latency  float64 `json:"latency"`  // TCP 平均延迟 ms
	HTTPMs   float64 `json:"http_ms"`  // HTTPS 验证请求耗时 ms
	Colo     string  `json:"colo"`     // 机房
	CC       string  `json:"cc"`       // 国家代码
	Country  string  `json:"country"`  // 国家中文
	City     string  `json:"city"`
	Speed    float64 `json:"speed"`    // MB/s
	Checks   int     `json:"checks"`   // 复验通过次数
	tcpOK    int
}

func (r *Result) Addr() string { return net.JoinHostPort(r.IP, strconv.Itoa(r.Port)) }

type Status struct {
	State    string `json:"state"` // idle|running|done|error
	Phase    string `json:"phase"`
	Done     int64  `json:"done"`
	Total    int64  `json:"total"`
	Found    int64  `json:"found"`
	Started  int64  `json:"started"`
	Finished int64  `json:"finished,omitempty"`
	Message  string `json:"message,omitempty"`
	Pid      int    `json:"pid"`
}

var st = &Status{State: "running"}
var stMu sync.Mutex

func saveStatus() {
	stMu.Lock()
	defer stMu.Unlock()
	b, _ := json.Marshal(st)
	os.WriteFile(RunDir+"/status.json.tmp", b, 0644)
	os.Rename(RunDir+"/status.json.tmp", RunDir+"/status.json")
}

func phase(name string, total int) {
	stMu.Lock()
	st.Phase, st.Total, st.Done, st.Found = name, int64(total), 0, 0
	stMu.Unlock()
	saveStatus()
	logf("== %s（%d 个）", name, total)
}

func logf(f string, a ...any) {
	fmt.Printf("%s %s\n", time.Now().Format("15:04:05"), fmt.Sprintf(f, a...))
}

// ---------------------------------------------------------------- IP 来源
func sampleIPs(n int) []string {
	type blk struct{ base uint32 }
	var blocks []uint32
	for _, c := range cfV4 {
		_, nw, err := net.ParseCIDR(c)
		if err != nil {
			continue
		}
		ones, _ := nw.Mask.Size()
		base := ipToU32(nw.IP)
		cnt := uint32(1) << (24 - ones)
		if ones > 24 {
			cnt = 1
		}
		for i := uint32(0); i < cnt; i++ {
			blocks = append(blocks, base+i<<8)
		}
	}
	rand.Shuffle(len(blocks), func(i, j int) { blocks[i], blocks[j] = blocks[j], blocks[i] })
	seen := map[uint32]bool{}
	var out []string
	for len(out) < n && len(seen) < len(blocks)*254 {
		for _, b := range blocks {
			if len(out) >= n {
				break
			}
			ip := b + uint32(1+rand.Intn(254))
			if seen[ip] {
				continue
			}
			seen[ip] = true
			out = append(out, u32ToIP(ip))
		}
	}
	return out
}

func expandExtra(items []string) []string {
	var out []string
	for _, it := range items {
		if strings.Contains(it, "/") {
			_, nw, err := net.ParseCIDR(it)
			if err != nil || nw.IP.To4() == nil {
				continue
			}
			ones, _ := nw.Mask.Size()
			if ones < 20 { // 太大的段只抽样
				for i := 0; i < 256; i++ {
					out = append(out, u32ToIP(ipToU32(nw.IP)+uint32(rand.Int63n(int64(1)<<(32-ones)))))
				}
				continue
			}
			base, size := ipToU32(nw.IP), uint32(1)<<(32-ones)
			for i := uint32(1); i < size-1 || (size <= 2 && i < size); i++ {
				out = append(out, u32ToIP(base+i))
			}
		} else if ip := net.ParseIP(strings.Split(it, ":")[0]); ip != nil && ip.To4() != nil {
			out = append(out, ip.String())
		}
	}
	return out
}

func ipToU32(ip net.IP) uint32 {
	ip = ip.To4()
	return uint32(ip[0])<<24 | uint32(ip[1])<<16 | uint32(ip[2])<<8 | uint32(ip[3])
}
func u32ToIP(v uint32) string {
	return fmt.Sprintf("%d.%d.%d.%d", v>>24, v>>16&255, v>>8&255, v&255)
}

// ---------------------------------------------------------------- 第 1 步：TCP
func tcpTest(c *Config, ips []string) []*Result {
	phase("TCP 延迟测试", len(ips))
	jobs := make(chan string)
	var mu sync.Mutex
	var out []*Result
	var wg sync.WaitGroup
	port := c.Ports[0]
	to := time.Duration(c.MaxLatency+200) * time.Millisecond
	for w := 0; w < c.Threads; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ip := range jobs {
				addr := net.JoinHostPort(ip, strconv.Itoa(port))
				var sum time.Duration
				ok := 0
				for t := 0; t < c.TCPTries; t++ {
					t0 := time.Now()
					conn, err := net.DialTimeout("tcp", addr, to)
					if err != nil {
						break // 丢一次就淘汰
					}
					sum += time.Since(t0)
					conn.Close()
					ok++
				}
				atomic.AddInt64(&st.Done, 1)
				if ok == c.TCPTries {
					lat := float64(sum.Microseconds()) / 1000 / float64(ok)
					if lat <= float64(c.MaxLatency) {
						mu.Lock()
						out = append(out, &Result{IP: ip, Port: port, Latency: lat, tcpOK: ok})
						mu.Unlock()
						atomic.AddInt64(&st.Found, 1)
					}
				}
			}
		}()
	}
	go progress()
	for _, ip := range ips {
		jobs <- ip
	}
	close(jobs)
	wg.Wait()
	sort.Slice(out, func(i, j int) bool { return out[i].Latency < out[j].Latency })
	logf("TCP 通过 %d 个（延迟 ≤ %dms、%d 次全通）", len(out), c.MaxLatency, c.TCPTries)
	return out
}

var progOnce sync.Once

func progress() {
	progOnce.Do(func() {
		go func() {
			for {
				time.Sleep(2 * time.Second)
				saveStatus()
			}
		}()
	})
}

// ---------------------------------------------------------------- 第 2 步：HTTPS 真实验证
// 把指定域名强制解析到这个 IP，正常校验证书，请求 /cdn-cgi/trace：
// 只有真正的 Cloudflare 边缘节点、且 TLS+SNI 在本地网络下没被干扰，才能拿到 200 和 colo=。
func clientFor(addr string, timeout time.Duration) *http.Client {
	d := &net.Dialer{Timeout: timeout}
	tr := &http.Transport{
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return d.DialContext(ctx, "tcp", addr)
		},
		TLSHandshakeTimeout:   timeout,
		ResponseHeaderTimeout: timeout,
		DisableKeepAlives:     true,
		ForceAttemptHTTP2:     false,
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
		Proxy:                 nil,
	}
	return &http.Client{Transport: tr, Timeout: timeout * 2,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func validate(c *Config, r *Result) error {
	host := c.ValidateHost
	url := fmt.Sprintf("https://%s:%d%s", host, r.Port, c.ValidatePath)
	if r.Port == 443 {
		url = fmt.Sprintf("https://%s%s", host, c.ValidatePath)
	}
	cl := clientFor(r.Addr(), 4*time.Second)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 cfyxip/"+Version)
	t0 := time.Now()
	resp, err := cl.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	ms := float64(time.Since(t0).Microseconds()) / 1000
	colo := ""
	if strings.Contains(c.ValidatePath, "cdn-cgi/trace") {
		if resp.StatusCode != 200 {
			return fmt.Errorf("HTTP %d", resp.StatusCode)
		}
		for _, l := range strings.Split(string(body), "\n") {
			if strings.HasPrefix(l, "colo=") {
				colo = strings.TrimSpace(l[5:])
			}
		}
	} else {
		if resp.StatusCode >= 500 {
			return fmt.Errorf("HTTP %d", resp.StatusCode)
		}
	}
	if colo == "" { // 自定义路径：从 cf-ray 头取机房，如 8c1b2a3d4e5f-LAX
		if ray := resp.Header.Get("Cf-Ray"); strings.Contains(ray, "-") {
			colo = ray[strings.LastIndex(ray, "-")+1:]
		}
	}
	if colo == "" {
		return errors.New("不是 Cloudflare 的响应（没有 colo / cf-ray）")
	}
	r.Colo, r.HTTPMs = colo, ms
	if v, ok := colos[colo]; ok {
		r.CC, r.Country, r.City = v[0], v[1], v[2]
	} else {
		r.CC, r.Country = "??", "未知"
	}
	return nil
}

func wantPlace(c *Config, r *Result) bool {
	if len(c.Colos) > 0 && !c.Colos[r.Colo] {
		return false
	}
	if len(c.Countries) > 0 && !c.Countries[r.CC] {
		return false
	}
	return true
}

func validateAll(c *Config, cands []*Result, need int) []*Result {
	// 每个候选在每个端口都单独验证（不同端口在部分地区会被单独干扰）
	var jobs []*Result
	for _, r := range cands {
		for _, p := range c.Ports {
			jobs = append(jobs, &Result{IP: r.IP, Port: p, Latency: r.Latency})
		}
	}
	phase("HTTPS 验证 + 识别落地机房", len(jobs))
	th := c.Threads / 4
	if th < 4 {
		th = 4
	}
	if th > 64 {
		th = 64
	}
	ch := make(chan *Result)
	var mu sync.Mutex
	var out []*Result
	var wg sync.WaitGroup
	fail := map[string]int{}
	var skipped int64
	for w := 0; w < th; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for r := range ch {
				err := validate(c, r)
				atomic.AddInt64(&st.Done, 1)
				mu.Lock()
				if err != nil {
					fail[shortErr(err)]++
				} else if !wantPlace(c, r) {
					skipped++
				} else {
					out = append(out, r)
					atomic.AddInt64(&st.Found, 1)
				}
				mu.Unlock()
			}
		}()
	}
	for i, j := range jobs {
		mu.Lock()
		enough := need > 0 && len(out) >= need
		mu.Unlock()
		if enough {
			logf("已找到足够的可用 IP，跳过剩余 %d 个", len(jobs)-i)
			break
		}
		ch <- j
	}
	close(ch)
	wg.Wait()
	byColo := map[string]int{}
	for _, r := range out {
		byColo[r.Colo]++
	}
	logf("HTTPS 验证通过且落地符合 %d 个；落地不符合 %d 个；失败原因 %v；机房分布 %v", len(out), skipped, fail, byColo)
	sort.Slice(out, func(i, j int) bool { return out[i].Latency+out[i].HTTPMs/4 < out[j].Latency+out[j].HTTPMs/4 })
	return out
}

func shortErr(err error) string {
	s := err.Error()
	switch {
	case strings.Contains(s, "certificate"), strings.Contains(s, "x509"):
		return "证书不对"
	case strings.Contains(s, "reset"):
		return "连接被重置"
	case strings.Contains(s, "timeout"), strings.Contains(s, "deadline"):
		return "超时"
	case strings.Contains(s, "EOF"):
		return "握手被断开"
	case strings.Contains(s, "refused"):
		return "拒绝连接"
	case strings.HasPrefix(s, "HTTP "):
		return s
	}
	if len(s) > 40 {
		s = s[len(s)-40:]
	}
	return s
}

// ---------------------------------------------------------------- 第 3 步：测速
func speedTest(c *Config, r *Result) float64 {
	url := fmt.Sprintf("https://%s:%d/__down?bytes=%d", c.SpeedHost, r.Port, c.SpeedBytes)
	cl := clientFor(r.Addr(), 5*time.Second)
	cl.Timeout = time.Duration(c.SpeedSeconds+6) * time.Second
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 cfyxip/"+Version)
	resp, err := cl.Do(req)
	if err != nil {
		return 0
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return 0
	}
	buf := make([]byte, 64*1024)
	var n int64
	t0 := time.Now()
	deadline := t0.Add(time.Duration(c.SpeedSeconds) * time.Second)
	for time.Now().Before(deadline) {
		k, err := resp.Body.Read(buf)
		n += int64(k)
		if err != nil {
			break
		}
	}
	sec := time.Since(t0).Seconds()
	if sec < 0.2 {
		sec = 0.2
	}
	return float64(n) / sec / 1e6
}

// ---------------------------------------------------------------- 主流程
func scan(cfgPath string) error {
	c := loadConfig(cfgPath)
	rand.Seed(time.Now().UnixNano())
	logf("Cloudflare 优选 IP %s 开始：抽样 %d、线程 %d、端口 %v、延迟上限 %dms、最低速度 %.1fMB/s、要 %d 个、落地国家 %v 机房 %v、验证域名 %s",
		Version, c.Sample, c.Threads, c.Ports, c.MaxLatency, c.MinSpeed, c.Count, keys(c.Countries), keys(c.Colos), c.ValidateHost)

	var ips []string
	seen := map[string]bool{}
	add := func(list []string) {
		for _, ip := range list {
			if !seen[ip] {
				seen[ip] = true
				ips = append(ips, ip)
			}
		}
	}
	if c.KeepOld { // 上次的好 IP 也参与，结果更稳定
		if old, err := loadResults(); err == nil {
			for _, r := range old {
				add([]string{r.IP})
			}
		}
	}
	add(expandExtra(c.ExtraIPs))
	add(sampleIPs(c.Sample))

	tcp := tcpTest(c, ips)
	if len(tcp) == 0 {
		return errors.New("没有 IP 通过 TCP 测试：检查网络，或把延迟上限调大")
	}
	need := c.Count * 6
	if !c.SpeedTest {
		need = c.Count * 2
	}
	// 只拿延迟最低的一批去验证，验证够了就停
	max := c.Count * 60
	if max < 600 {
		max = 600
	}
	if len(tcp) > max {
		tcp = tcp[:max]
	}
	ok := validateAll(c, tcp, need)
	if len(ok) == 0 {
		if len(c.Countries)+len(c.Colos) > 0 {
			return errors.New("有 IP 能用，但没有落地在所选国家/机房的：换几个国家，或加大抽样数量")
		}
		return errors.New("所有候选都没通过 HTTPS 验证：验证域名可能被墙/填错了")
	}

	var final []*Result
	if c.SpeedTest {
		phase("下载测速", min(len(ok), c.Count*4))
		tested := 0
		for _, r := range ok {
			if len(final) >= c.Count*2 || tested >= c.Count*4 {
				break
			}
			tested++
			r.Speed = speedTest(c, r)
			atomic.AddInt64(&st.Done, 1)
			logf("  %-21s %s %-4s 延迟 %5.0fms  速度 %.2f MB/s", r.Addr(), r.CC, r.Colo, r.Latency, r.Speed)
			if r.Speed >= c.MinSpeed {
				final = append(final, r)
				atomic.AddInt64(&st.Found, 1)
			}
		}
		if len(final) == 0 {
			return fmt.Errorf("测了 %d 个都没达到最低速度 %.1fMB/s：把最低速度调低一点", tested, c.MinSpeed)
		}
	} else {
		final = ok
	}

	if c.Recheck > 0 { // 复验：隔一会儿再验几次，偶尔能通的不要
		phase("复验稳定性", len(final))
		var keep []*Result
		for _, r := range final {
			pass := 0
			for i := 0; i < c.Recheck; i++ {
				if i > 0 {
					time.Sleep(700 * time.Millisecond)
				}
				t := *r
				if validate(c, &t) == nil && t.Colo == r.Colo {
					pass++
				}
			}
			r.Checks = pass
			atomic.AddInt64(&st.Done, 1)
			if pass == c.Recheck {
				keep = append(keep, r)
				atomic.AddInt64(&st.Found, 1)
			} else {
				logf("  淘汰 %s：复验 %d/%d", r.Addr(), pass, c.Recheck)
			}
		}
		final = keep
		if len(final) == 0 {
			return errors.New("复验全部没通过，网络可能不稳定，稍后再试")
		}
	}

	sort.Slice(final, func(i, j int) bool {
		if c.SpeedTest && final[i].Speed != final[j].Speed {
			return final[i].Speed > final[j].Speed
		}
		return final[i].Latency < final[j].Latency
	})
	if len(final) > c.Count {
		final = final[:c.Count]
	}
	if err := saveResults(c, final); err != nil {
		return err
	}
	logf("完成：得到 %d 个可用优选 IP，已写入 %s/xyip.txt", len(final), DataDir)
	for _, r := range final {
		logf("  %s", line(c, r))
	}
	if c.Push {
		if err := push(c); err != nil {
			logf("推送 GitHub 失败：%v", err)
			stMu.Lock()
			st.Message = "扫描成功，但推送 GitHub 失败：" + err.Error()
			stMu.Unlock()
		}
	}
	return nil
}

func keys(m map[string]bool) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func line(c *Config, r *Result) string {
	rep := strings.NewReplacer("{colo}", r.Colo, "{cc}", r.CC, "{country}", r.Country, "{city}", r.City,
		"{speed}", strconv.FormatFloat(r.Speed, 'f', 2, 64), "{latency}", strconv.Itoa(int(r.Latency+0.5)),
		"{ip}", r.IP, "{port}", strconv.Itoa(r.Port))
	rem := strings.TrimSpace(rep.Replace(c.Remark))
	if !c.SpeedTest {
		rem = strings.TrimSpace(strings.ReplaceAll(rem, "0.00MB/s", ""))
	}
	return r.Addr() + "#" + rem
}

func saveResults(c *Config, rs []*Result) error {
	os.MkdirAll(DataDir, 0755)
	var b bytes.Buffer
	for _, r := range rs {
		b.WriteString(line(c, r) + "\n")
	}
	if err := writeAtomic(DataDir+"/xyip.txt", b.Bytes()); err != nil {
		return err
	}
	j, _ := json.MarshalIndent(map[string]any{"time": time.Now().Unix(), "results": rs}, "", " ")
	return writeAtomic(DataDir+"/result.json", j)
}

func loadResults() ([]Result, error) {
	b, err := os.ReadFile(DataDir + "/result.json")
	if err != nil {
		return nil, err
	}
	var j struct {
		Results []Result `json:"results"`
	}
	err = json.Unmarshal(b, &j)
	return j.Results, err
}

func writeAtomic(p string, b []byte) error {
	if err := os.WriteFile(p+".tmp", b, 0644); err != nil {
		return err
	}
	return os.Rename(p+".tmp", p)
}

// ---------------------------------------------------------------- 推送 GitHub
func push(c *Config) error {
	if c.GhToken == "" || c.GhRepo == "" {
		return errors.New("没有填 GitHub 仓库或令牌")
	}
	body, err := os.ReadFile(DataDir + "/xyip.txt")
	if err != nil {
		return errors.New("还没有扫描结果")
	}
	api := "https://api.github.com/repos/" + strings.Trim(c.GhRepo, "/") + "/contents/" + strings.TrimLeft(c.GhPath, "/")
	cl := &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{Proxy: nil}}
	do := func(method, url string, payload any) (int, map[string]any, error) {
		var rd io.Reader
		if payload != nil {
			b, _ := json.Marshal(payload)
			rd = bytes.NewReader(b)
		}
		var lastErr error
		for i := 0; i < 3; i++ {
			req, _ := http.NewRequest(method, url, rd)
			req.Header.Set("Authorization", "Bearer "+c.GhToken)
			req.Header.Set("Accept", "application/vnd.github+json")
			req.Header.Set("User-Agent", "cfyxip")
			resp, err := cl.Do(req)
			if err != nil {
				lastErr = err
				time.Sleep(3 * time.Second)
				if payload != nil {
					b, _ := json.Marshal(payload)
					rd = bytes.NewReader(b)
				}
				continue
			}
			defer resp.Body.Close()
			var j map[string]any
			json.NewDecoder(resp.Body).Decode(&j)
			return resp.StatusCode, j, nil
		}
		return 0, nil, lastErr
	}
	code, j, err := do("GET", api+"?ref="+c.GhBranch, nil)
	if err != nil {
		return err
	}
	sha, _ := j["sha"].(string)
	if code == 200 {
		if old, _ := j["content"].(string); old != "" {
			if dec, e := base64.StdEncoding.DecodeString(strings.ReplaceAll(old, "\n", "")); e == nil && bytes.Equal(dec, body) {
				logf("GitHub 上的 %s 和这次结果一样，不用推送", c.GhPath)
				return nil
			}
		}
	} else if code != 404 {
		return fmt.Errorf("读取仓库失败 HTTP %d：%v", code, j["message"])
	}
	payload := map[string]any{"message": "优选 IP 更新 " + time.Now().Format("2006-01-02 15:04"),
		"content": base64.StdEncoding.EncodeToString(body), "branch": c.GhBranch}
	if sha != "" {
		payload["sha"] = sha
	}
	code, j, err = do("PUT", api, payload)
	if err != nil {
		return err
	}
	if code != 200 && code != 201 {
		return fmt.Errorf("HTTP %d：%v", code, j["message"])
	}
	logf("已推送到 GitHub：https://raw.githubusercontent.com/%s/%s/%s", strings.Trim(c.GhRepo, "/"), c.GhBranch, strings.TrimLeft(c.GhPath, "/"))
	return nil
}

// ---------------------------------------------------------------- 入口
func main() {
	json.Unmarshal(coloJSON, &colos)
	if d := os.Getenv("CFYXIP_DATA"); d != "" {
		DataDir = d
	}
	if d := os.Getenv("CFYXIP_RUN"); d != "" {
		RunDir = d
	}
	os.MkdirAll(RunDir, 0755)
	cmd := "scan"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	cfg := ""
	for i, a := range os.Args {
		if a == "-c" && i+1 < len(os.Args) {
			cfg = os.Args[i+1]
		}
	}
	switch cmd {
	case "version":
		fmt.Println(Version)
	case "colos": // 给 LuCI 用：国家列表
		type cc struct {
			Code, Name string
			Colos     []string
		}
		m := map[string]*cc{}
		for k, v := range colos {
			if m[v[0]] == nil {
				m[v[0]] = &cc{Code: v[0], Name: v[1]}
			}
			m[v[0]].Colos = append(m[v[0]].Colos, k+" "+v[2])
		}
		var out []*cc
		for _, v := range m {
			sort.Strings(v.Colos)
			out = append(out, v)
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Code < out[j].Code })
		json.NewEncoder(os.Stdout).Encode(out)
	case "push":
		c := loadConfig(cfg)
		if err := push(c); err != nil {
			fmt.Println("推送失败：", err)
			os.Exit(1)
		}
	case "scan":
		st.Started, st.Pid = time.Now().Unix(), os.Getpid()
		saveStatus()
		err := scan(cfg)
		stMu.Lock()
		st.Finished = time.Now().Unix()
		if err != nil {
			st.State, st.Message = "error", err.Error()
		} else {
			st.State = "done"
		}
		st.Phase = ""
		stMu.Unlock()
		saveStatus()
		if err != nil {
			logf("失败：%v", err)
			os.Exit(1)
		}
	default:
		fmt.Fprintln(os.Stderr, "用法: cfyxip scan|push|colos|version [-c 配置]")
		os.Exit(2)
	}
	_ = bufio.NewReader
}
