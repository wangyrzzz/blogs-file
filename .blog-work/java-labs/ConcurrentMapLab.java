import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

public class ConcurrentMapLab {
    public static void main(String[] args) throws Exception {
        run(false);
        run(true);
    }
    static void run(boolean atomic) throws Exception {
        int workers=8;
        ConcurrentHashMap<String,String> map=new ConcurrentHashMap<>();
        CyclicBarrier barrier=new CyclicBarrier(workers);
        AtomicInteger winners=new AtomicInteger();
        try (ExecutorService pool=Executors.newFixedThreadPool(workers)) {
            List<Future<?>> futures=new ArrayList<>();
            for (int i=0;i<workers;i++) {
                final String owner="worker-"+i;
                futures.add(pool.submit(() -> {
                    boolean absent=!map.containsKey("job-1");
                    barrier.await(5,TimeUnit.SECONDS);
                    if (atomic) {
                        if (map.putIfAbsent("job-1",owner)==null) {
                            winners.incrementAndGet();
                        }
                    } else if (absent) {
                        map.put("job-1",owner);
                        winners.incrementAndGet();
                    }
                    return null;
                }));
            }
            for (Future<?> f:futures) f.get();
        }
        System.out.println("atomic="+atomic+", winners="+winners.get()
                +", mappings="+map.size());
        if (atomic && winners.get()!=1) throw new AssertionError();
        if (!atomic && winners.get()!=workers) throw new AssertionError();
    }
}