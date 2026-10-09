import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.ReentrantLock;

public class LockInventoryLab {
    interface Stock {
        boolean take(int amount);
        int remaining();
    }
    static final class CasStock implements Stock {
        private final AtomicInteger value;
        CasStock(int initial) { value = new AtomicInteger(initial); }
        public boolean take(int amount) {
            if (amount <= 0) throw new IllegalArgumentException();
            for (;;) {
                int current = value.get();
                if (current < amount) return false;
                if (value.compareAndSet(current, current-amount)) return true;
                Thread.onSpinWait();
            }
        }
        public int remaining() { return value.get(); }
    }
    static final class MutexStock implements Stock {
        private final ReentrantLock lock = new ReentrantLock();
        private int value;
        MutexStock(int initial) { value = initial; }
        public boolean take(int amount) {
            if (amount <= 0) throw new IllegalArgumentException();
            lock.lock();
            try {
                if (value < amount) return false;
                value -= amount;
                return true;
            } finally { lock.unlock(); }
        }
        public int remaining() {
            lock.lock();
            try { return value; }
            finally { lock.unlock(); }
        }
    }
    static void verify(String name, Stock stock) throws Exception {
        int workers=8;
        int initial=10000;
        AtomicInteger successful=new AtomicInteger();
        CountDownLatch start=new CountDownLatch(1);
        try (ExecutorService pool=Executors.newFixedThreadPool(workers)) {
            List<Future<?>> futures=new ArrayList<>();
            for (int i=0;i<workers;i++) {
                futures.add(pool.submit(() -> {
                    start.await();
                    for (int j=0;j<2000;j++) {
                        if (stock.take(1)) successful.incrementAndGet();
                    }
                    return null;
                }));
            }
            start.countDown();
            for (Future<?> future:futures) future.get();
        }
        if (successful.get()+stock.remaining()!=initial) {
            throw new AssertionError("inventory conservation violated");
        }
        System.out.println(name+": accepted="+successful.get()
                +", remaining="+stock.remaining());
    }
    public static void main(String[] args) throws Exception {
        verify("CAS",new CasStock(10000));
        verify("MUTEX",new MutexStock(10000));
    }
}